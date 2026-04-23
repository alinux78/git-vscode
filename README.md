# Git Workspace Explorer

A VS Code extension that adds a dedicated activity bar panel for browsing the git history of every folder in your workspace.

## Features

- **Workspace folder list** — all top-level workspace folders appear in a sidebar panel; click any folder to open its git history.
- **Commit history table** — shows short hash, commit message, author, and relative date for the selected branch, loaded 50 commits at a time.
- **Infinite scroll** — reaching the bottom of the list automatically loads the next page of commits.
- **Branch selector** — switch between any local branch without leaving the panel; a "↩ Current" button jumps back to the checked-out branch.
- **Expandable commit detail** — click a commit row to reveal the list of changed files with color-coded status badges (A / M / D / R / C).
- **Inline diff view** — click any changed file to open a side-by-side diff of that file at the selected commit versus its parent, using VS Code's native diff editor.
- **Commit search** — a fixed search bar at the bottom of the panel searches across commit messages, authors, and short hashes on the active branch; ↑ / ↓ buttons cycle through all matches, scrolling and loading commits as needed.
- **Theme-aware UI** — the panel inherits VS Code CSS variables so it looks correct in any light or dark theme.

## Requirements

- VS Code 1.85 or newer
- `git` available on `PATH`

## Building from source

```bash
# 1. Install dependencies
npm install

# 2. One-shot TypeScript compile
npm run compile

# 3. (Optional) watch mode — recompiles on every save
npm run watch
```

To run the extension in a development host, open this folder in VS Code and press **F5**. VS Code will compile the project and launch an Extension Development Host window with the extension loaded.

> Running `node out/extension.js` directly will always fail with `Cannot find module 'vscode'` — the `vscode` module is injected by VS Code's extension host at runtime, not installed via npm.

## Packaging a .vsix file

Make sure the VS Code Extension CLI is installed globally:

```bash
npm install -g @vscode/vsce
```

Then from the project root:

```bash
make package
```

This produces a file named `out/git-workspace-explorer-<version>.vsix`.

## Installing a .vsix file

**From the VS Code UI:**

1. Open the Extensions panel (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Click the **⋯** (More Actions) button in the top-right corner of the panel.
3. Select **Install from VSIX…**.
4. Browse to the `.vsix` file and confirm.

**From the command line:**

```bash
code --install-extension git-workspace-explorer-<version>.vsix
```

After installation, reload VS Code if prompted. The **Git Workspace** icon will appear in the activity bar.
