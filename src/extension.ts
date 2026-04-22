import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface Commit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
  relativeDate: string;
}

// ─── Git helpers ────────────────────────────────────────────────────────────

async function gitBranch(cwd: string): Promise<string> {
  try {
    const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd });
    return stdout.trim();
  } catch {
    return '(not a git repo)';
  }
}

async function gitLog(cwd: string, limit = 50): Promise<Commit[]> {
  try {
    const format = '%H\x1f%h\x1f%s\x1f%an\x1f%ad\x1f%ar';
    const { stdout } = await execAsync(
      `git log -${limit} --date=short --format="${format}"`,
      { cwd }
    );
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [hash, shortHash, subject, author, date, relativeDate] = line.split('\x1f');
        return { hash, shortHash, subject, author, date, relativeDate };
      });
  } catch {
    return [];
  }
}

// ─── Tree view ───────────────────────────────────────────────────────────────

class FolderItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly folderPath: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.tooltip = folderPath;
    this.description = folderPath;
    this.iconPath = new vscode.ThemeIcon('folder');
    this.command = {
      command: 'gitWorkspaceExplorer.showGitInfo',
      title: 'Show Git Info',
      arguments: [folderPath, label],
    };
    this.contextValue = 'workspaceFolder';
  }
}

class WorkspaceFoldersProvider implements vscode.TreeDataProvider<FolderItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: FolderItem): vscode.TreeItem {
    return element;
  }

  getChildren(): FolderItem[] {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return [];
    }
    return folders.map(f => new FolderItem(f.name, f.uri.fsPath));
  }
}

// ─── Webview ─────────────────────────────────────────────────────────────────

function buildWebview(folderName: string, branch: string, commits: Commit[]): string {
  const commitRows = commits.length === 0
    ? '<tr><td colspan="4" class="empty">No commits found</td></tr>'
    : commits.map(c => `
        <tr>
          <td class="hash" title="${escHtml(c.hash)}">${escHtml(c.shortHash)}</td>
          <td class="subject">${escHtml(c.subject)}</td>
          <td class="author">${escHtml(c.author)}</td>
          <td class="date" title="${escHtml(c.date)}">${escHtml(c.relativeDate)}</td>
        </tr>`).join('');

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Git: ${escHtml(folderName)}</title>
  <style>
    :root {
      --radius: 6px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    body { margin: 0; padding: 16px; }

    h1 { font-size: 1.2em; margin: 0 0 12px; display: flex; align-items: center; gap: 8px; }
    h1 .folder-icon { opacity: 0.7; }

    .branch-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 0.9em;
      margin-bottom: 20px;
    }

    h2 { font-size: 1em; margin: 0 0 8px; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.05em; }

    table { width: 100%; border-collapse: collapse; font-size: 0.92em; }
    thead th {
      text-align: left;
      padding: 6px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      opacity: 0.6;
      font-weight: 600;
      font-size: 0.85em;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    tbody tr { transition: background 0.1s; }
    tbody tr:hover { background: var(--vscode-list-hoverBackground); }
    tbody td { padding: 5px 8px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.15)); vertical-align: top; }

    .hash {
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--vscode-textLink-foreground);
      white-space: nowrap;
    }
    .subject { width: 55%; }
    .author { white-space: nowrap; opacity: 0.8; }
    .date   { white-space: nowrap; opacity: 0.7; text-align: right; }
    .empty  { text-align: center; padding: 24px; opacity: 0.5; }
  </style>
</head>
<body>
  <h1><span class="folder-icon">📁</span>${escHtml(folderName)}</h1>

  <div class="branch-pill">
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0zm0 2.122a2.25 2.25 0 1 0-1.5 0v.878A2.25 2.25 0 0 0 5.75 8.5h1.5a.75.75 0 0 1 .75.75v.878a2.25 2.25 0 1 0 1.5 0V9.25A2.25 2.25 0 0 0 7.25 7h-1.5A.75.75 0 0 1 5 6.25v-.878zm4.75 7.378a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0zM11.25 4a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5z"/>
    </svg>
    ${escHtml(branch)}
  </div>

  <h2>Commit History</h2>
  <table>
    <thead>
      <tr>
        <th>Hash</th>
        <th>Message</th>
        <th>Author</th>
        <th style="text-align:right">Date</th>
      </tr>
    </thead>
    <tbody>
      ${commitRows}
    </tbody>
  </table>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Activation ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  const provider = new WorkspaceFoldersProvider();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('gitWorkspaceExplorer.folders', provider),

    vscode.commands.registerCommand('gitWorkspaceExplorer.refresh', () => provider.refresh()),

    vscode.commands.registerCommand(
      'gitWorkspaceExplorer.showGitInfo',
      async (folderPath: string, folderName: string) => {
        const panel = vscode.window.createWebviewPanel(
          'gitWorkspaceExplorer.info',
          `Git: ${folderName}`,
          vscode.ViewColumn.One,
          { enableScripts: false }
        );

        panel.webview.html = buildWebview(folderName, 'Loading…', []);

        const [branch, commits] = await Promise.all([
          gitBranch(folderPath),
          gitLog(folderPath),
        ]);

        panel.webview.html = buildWebview(folderName, branch, commits);
      }
    ),

    // Refresh tree when workspace folders change
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh())
  );
}

export function deactivate(): void {}
