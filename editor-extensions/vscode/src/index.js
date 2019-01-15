/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';
const vscode = require("vscode");
const {Uri} = vscode;
const {LanguageClient, RevealOutputChannelOn} = require("vscode-languageclient");
const {TextDocument} = require('vscode-languageserver-types');
const path = require('path')
const fs = require('fs')

const getLocation = (context) => {
    let binaryLocation = vscode.workspace.getConfiguration('reason_language_server').get('location')

    if (!binaryLocation) {
        // see if it's bundled with the extension
        // hmm actually I could bundle one for each platform & probably be fine
        // I guess it's 9mb binary. I wonder if I can cut that down?
        const ext = process.platform === 'win32'
		? '.exe'
		: (process.platform === 'linux' ? '.linux' : '');
        binaryLocation = path.join(vscode.workspace.rootPath, 'node_modules', '@jaredly', 'reason-language-server', 'lib', 'bs', 'native', 'bin.native' + ext)
        if (!fs.existsSync(binaryLocation)) {
            binaryLocation = context.asAbsolutePath('bin.native' + ext)
            if (!fs.existsSync(binaryLocation)) {
                vscode.window.showErrorMessage('Reason Language Server not found! Please install the npm package @jaredly/reason-language-server to enable IDE functionality');
                return null
            }
        }
    } else {
        if (!binaryLocation.startsWith('/')) {
            binaryLocation = path.join(vscode.workspace.rootPath, binaryLocation)
        }
        if (!fs.existsSync(binaryLocation)) {
            vscode.window.showErrorMessage('Reason Language Server not found! You specified ' + binaryLocation);
            return null
        }
    }
    return binaryLocation
}

const shouldReload = () => vscode.workspace.getConfiguration('reason_language_server').get('reloadOnChange')

function activate(context) {
    // The server is implemented in reason

    let clientOptions = {
        documentSelector: [
            {scheme: 'file', language: 'reason'},
            {scheme: 'file', language: 'ocaml'},
            {scheme: 'file', language: 'reason_lisp'}
        ],
        synchronize: {
            // Synchronize the setting section 'reason_language_server' to the server
            configurationSection: 'reason_language_server',
            fileEvents: [
                vscode.workspace.createFileSystemWatcher('**/bsconfig.json'),
                vscode.workspace.createFileSystemWatcher('**/.merlin')
            ]
        },
        revealOutputChannelOn: RevealOutputChannelOn.Never,
    };

    let client = null
    let lastStartTime = null
    let interval = null

    const startChecking = (location) => {
        vscode.window.showInformationMessage('DEBUG MODE: Will auto-restart the reason language server if it recompiles');
        interval = setInterval(() => {
            try {
                const stat = fs.statSync(location)
                const mtime = stat.mtime.getTime()
                if (mtime > lastStartTime) {
                    restart()
                }
            } catch (e) {
                console.warn('Failed to check binary mtime ' + e.message)
            }
        }, 500);
        context.subscriptions.push({dispose: () => clearInterval(checkForBinaryChange)})
    }

    /**
     * client.sendRequest(...).then(response => {
     * })
     *
     * client.sendNotification()....
     * that could be a way to implement the code actions that I want to do.
     *
     * alsooo I think I want
     */

    const restart = () => {
        if (client) {
            client.stop();
        }
        const location = getLocation(context)
        if (!location) return
        const binLocation = process.platform === 'win32' ? location + '.hot.exe' : location
        if (binLocation != location) {
            fs.writeFileSync(binLocation, fs.readFileSync(location))
        }
        client = new LanguageClient(
            'reason-language-server',
            'Reason Language Server',
            {
                command: binLocation,
                args: [],
            },
            Object.assign({}, clientOptions, {
                revealOutputChannelOn: vscode.workspace.getConfiguration('reason_language_server').get('show_debug_errors')
                    ? RevealOutputChannelOn.Error
                    : RevealOutputChannelOn.Never
            }),
        );
        lastStartTime = Date.now()
        context.subscriptions.push(client.start());
        if (shouldReload()) {
            vscode.window.showInformationMessage('Reason language server restarted');
            if (!interval) {
                startChecking(location)
            }
        } else if (interval) {
            vscode.window.showInformationMessage('DEBUG MODE OFF - no longer monitoring reason-language-server binary');
            clearInterval(interval)
            interval = null
        }
    }

    vscode.workspace.onDidChangeConfiguration(evt => {
        if (evt.affectsConfiguration('reason_language_server.location')) {
            restart()
        }
    })

    vscode.commands.registerCommand('reason-language-server.restart', restart);

    const createInterface = (minimal) => {
        if (!client) {
            return vscode.window.showInformationMessage('Language server not running');
        }
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return vscode.window.showInformationMessage('No active editor');
        }
        if (fs.existsSync(editor.document.uri.fsPath + 'i')) {
            return vscode.window.showInformationMessage('Interface file already exists');
        }
        client.sendRequest("custom:reasonLanguageServer/createInterface", {
            "uri": editor.document.uri.toString(),
            "minimal": minimal
        })
    };

    vscode.commands.registerCommand('reason-language-server.create_interface', () => {
        createInterface(false)
    });

    class PpxedSourceProvider {
        provideTextDocumentContent(uri, token) {
            if (!client) {
                return Promise.reject("No language client running")
            }

            return client.sendRequest("custom:reasonLanguageServer/showPpxedSource", {
                "textDocument": {
                    "uri": uri.with({scheme: 'file'}).toString(),
                },
                // unused currently
                "position": {character: 0, line: 0},
            })
        }
    }

    const contentProviderRegistration = vscode.workspace.registerTextDocumentContentProvider(
        "ppxed-source",
        new PpxedSourceProvider(),
    );

    const showPpxedSource = () => {
        if (!client) {
            return vscode.window.showInformationMessage('Language server not running');
        }
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return vscode.window.showInformationMessage('No active editor');
        }
        if (editor.document.languageId !== 'ocaml' && editor.document.languageId !== 'reason') {
            return vscode.window.showInformationMessage('Not an OCaml or Reason file');
        }

        const document = TextDocument.create(editor.document.uri.with({scheme: 'ppxed-source'}), editor.document.languageId, 1, '');
        vscode.window.showTextDocument(document);
    };

    vscode.commands.registerCommand('reason-language-server.show_ppxed_source', () => {
        showPpxedSource()
    });

    // vscode.commands.registerCommand('reason-language-server.create_interface_minimal', () => {
    //     createInterface(true)
    // });

    restart();

    // vscode.commands.registerCommand('reason-language-server.expand_switch', () => {
    // });

}
exports.activate = activate;
