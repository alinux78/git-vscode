# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run compile      # one-shot TypeScript build → out/
npm run watch        # incremental rebuild on save
vsce package         # produce a .vsix installable package (requires: npm i -g @vscode/vsce)
```

**Running the extension** requires VS Code — there is no standalone test runner. Press **F5** inside VS Code with this folder open; `.vscode/launch.json` is pre-configured to launch an Extension Development Host with a pre-build step.

> `node out/extension.js` will always fail with `Cannot find module 'vscode'` — the `vscode` module is injected by VS Code's extension host at runtime, not from npm.

## Architecture

All logic lives in a single file: `src/extension.ts`. It is split into four sections:

1. **Git helpers** (`gitBranch`, `gitLog`) — thin wrappers around `child_process.exec` that shell out to `git`. They swallow errors and return safe fallbacks so the UI never crashes on non-git folders.

2. **Tree view** (`FolderItem`, `WorkspaceFoldersProvider`) — a `TreeDataProvider` that maps `vscode.workspace.workspaceFolders` to flat, non-collapsible tree items. Each item fires `gitWorkspaceExplorer.showGitInfo` on click.

3. **Webview** (`buildWebview`, `escHtml`) — pure HTML/CSS string builder. Uses VS Code CSS variables (`--vscode-*`) so it inherits the active theme automatically. All user-supplied strings are run through `escHtml` before insertion.

4. **Activation** (`activate`) — registers the tree data provider, the `refresh` command, and the `showGitInfo` command. The info command creates a `WebviewPanel`, shows a loading state immediately, then replaces it once the two git calls resolve in parallel.

## Extension manifest highlights (`package.json`)

- Activity bar container id: `gitWorkspaceExplorer` / icon: `media/git-branch.svg`
- Tree view id: `gitWorkspaceExplorer.folders` (referenced in `activationEvents`)
- Compiled entry point: `out/extension.js` (never edit this directly)
- `@types/vscode` is a dev-only type stubs package; the real `vscode` API is runtime-only
