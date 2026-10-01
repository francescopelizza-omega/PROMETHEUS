// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * vscode-stub.mjs — a stand-in for the "vscode" module, for the plain node:test runs.
 *
 * The bare specifier "vscode" is injected by the extension host at require time; outside that
 * host it does not exist as an installed package at all, so it has to resolve to SOMETHING.
 *
 * This used to be `export default {}`, which was enough while only `session.test.ts` needed it —
 * nothing there touched a real API. Testing anything that reaches `chat-view.ts` needs more: it
 * calls `vscode.Uri.joinPath` at resolve time, and an empty object fails with
 * "Cannot read properties of undefined (reading 'joinPath')" — which reads like a product bug
 * and is not. Only the members the source actually touches are stubbed, deliberately: a stub
 * that guesses at behaviour would let a test pass for the wrong reason.
 */
const disposable = () => ({ dispose() {} });

/** A `Uri`-shaped value: the extension only ever reads `fsPath` and stringifies it. */
const uri = (fsPath) => ({
  fsPath,
  scheme: "file",
  path: fsPath,
  toString: () => `file://${fsPath}`,
});

export const Uri = {
  file: uri,
  joinPath: (base, ...segments) => uri([base?.fsPath ?? "", ...segments].join("/")),
};

export const workspace = {
  workspaceFolders: undefined,
  getConfiguration: () => ({ get: () => undefined }),
  onDidChangeWorkspaceFolders: disposable,
  onDidChangeConfiguration: disposable,
};

export const window = {
  registerWebviewViewProvider: () => disposable(),
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
};

export const commands = {
  registerCommand: () => disposable(),
  executeCommand: async () => undefined,
};

export class EventEmitter {
  constructor() {
    this.event = disposable;
  }
  fire() {}
  dispose() {}
}

export const ExtensionMode = { Test: 3 };
export const ViewColumn = { One: 1 };
export class RelativePattern {
  constructor(base, pattern) {
    this.base = base;
    this.pattern = pattern;
  }
}

export default {
  Uri,
  workspace,
  window,
  commands,
  EventEmitter,
  ExtensionMode,
  ViewColumn,
  RelativePattern,
};
