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

interface ChangedFile {
  status: string;   // A, M, D, R, C
  file: string;     // display label: "path" or "old → new"
  oldPath: string;  // path at parent commit (before)
  newPath: string;  // path at this commit (after)
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

async function gitFilesChanged(cwd: string, hash: string): Promise<ChangedFile[]> {
  try {
    const { stdout } = await execAsync(
      `git diff-tree --no-commit-id -r --name-status ${hash}`,
      { cwd }
    );
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const parts = line.split('\t');
        const rawStatus = parts[0].trim();
        const status = rawStatus[0]; // R100 → R, C090 → C
        if (status === 'R' || status === 'C') {
          const oldPath = parts[1] ?? '';
          const newPath = parts[2] ?? '';
          return { status, file: `${oldPath} → ${newPath}`, oldPath, newPath };
        }
        const p = parts[1] ?? '';
        return { status, file: p, oldPath: p, newPath: p };
      });
  } catch {
    return [];
  }
}

// ─── Git content provider ────────────────────────────────────────────────────

class GitShowProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'gitshow';

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params   = new URLSearchParams(uri.query);
    const ref      = params.get('ref')  ?? '';
    const filePath = params.get('file') ?? '';
    const cwd      = params.get('cwd')  ?? '';
    if (!ref || !filePath || !cwd) return '';
    try {
      const { stdout } = await execAsync(`git show "${ref}:${filePath}"`, { cwd });
      return stdout;
    } catch {
      return ''; // initial commit has no parent; added/deleted edge cases
    }
  }
}

function makeGitShowUri(ref: string, filePath: string, cwd: string): vscode.Uri {
  const safePath = filePath.replace(/\//g, '%2F');
  const query = `ref=${encodeURIComponent(ref)}&file=${encodeURIComponent(filePath)}&cwd=${encodeURIComponent(cwd)}`;
  return vscode.Uri.from({ scheme: GitShowProvider.scheme, path: `/${ref}/${safePath}`, query });
}

const EMPTY_URI = vscode.Uri.from({ scheme: GitShowProvider.scheme, path: '/empty' });

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
    ? '<tr><td colspan="5" class="empty">No commits found</td></tr>'
    : commits.map(c => `
        <tr class="commit-row" data-hash="${escHtml(c.hash)}">
          <td class="arrow">▶</td>
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
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    body { margin: 0; padding: 16px; }

    h1 { font-size: 1.2em; margin: 0 0 12px; display: flex; align-items: center; gap: 8px; }

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

    .commit-row { cursor: pointer; }
    .commit-row:hover { background: var(--vscode-list-hoverBackground); }
    .commit-row.expanded { background: var(--vscode-list-activeSelectionBackground);
                           color: var(--vscode-list-activeSelectionForeground); }
    .commit-row.expanded td { border-bottom: none; }

    tbody td { padding: 5px 8px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.15)); vertical-align: top; }

    .arrow { width: 16px; text-align: center; font-size: 0.7em; opacity: 0.5; transition: transform 0.15s; user-select: none; }
    .commit-row.expanded .arrow { transform: rotate(90deg); opacity: 1; }

    .hash {
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--vscode-textLink-foreground);
      white-space: nowrap;
    }
    .commit-row.expanded .hash { color: inherit; }
    .subject { width: 52%; }
    .author { white-space: nowrap; opacity: 0.8; }
    .date   { white-space: nowrap; opacity: 0.7; text-align: right; }
    .empty  { text-align: center; padding: 24px; opacity: 0.5; }

    /* detail row */
    .detail-row td {
      padding: 0;
      border-bottom: 2px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
    }
    .file-list {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 16px;
      padding: 8px 12px 10px 32px;
    }
    .file-list.loading { opacity: 0.5; font-style: italic; }
    .file-entry {
      display: flex; align-items: baseline; gap: 5px;
      font-size: 0.88em; white-space: nowrap;
      cursor: pointer;
    }
    .file-entry:hover .file-name { text-decoration: underline; opacity: 1; }
    .file-status {
      font-family: var(--vscode-editor-font-family, monospace);
      font-weight: 700;
      font-size: 0.8em;
      width: 14px;
      text-align: center;
    }
    .s-A { color: #3fb950; }
    .s-M { color: #d29922; }
    .s-D { color: #f85149; }
    .s-R { color: #58a6ff; }
    .s-C { color: #bc8cff; }
    .file-name { opacity: 0.9; }
    .no-files { opacity: 0.5; font-style: italic; }
  </style>
</head>
<body>
  <h1>📁 ${escHtml(folderName)}</h1>

  <div class="branch-pill">
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0zm0 2.122a2.25 2.25 0 1 0-1.5 0v.878A2.25 2.25 0 0 0 5.75 8.5h1.5a.75.75 0 0 1 .75.75v.878a2.25 2.25 0 1 0 1.5 0V9.25A2.25 2.25 0 0 0 7.25 7h-1.5A.75.75 0 0 1 5 6.25v-.878zm4.75 7.378a.75.75 0 1 1-1.5 0 .75.75 0 0 0 1.5 0zM11.25 4a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5z"/>
    </svg>
    ${escHtml(branch)}
  </div>

  <h2>Commit History</h2>
  <table>
    <thead>
      <tr>
        <th></th>
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

  <script>
    const vscode = acquireVsCodeApi();
    const pending = new Set();

    document.addEventListener('click', e => {
      // file entry click — open diff view
      const fileEntry = e.target.closest('.file-entry');
      if (fileEntry) {
        e.stopPropagation();
        vscode.postMessage({
          type:    'openDiff',
          hash:    fileEntry.dataset.hash,
          status:  fileEntry.dataset.status,
          oldPath: fileEntry.dataset.oldPath,
          newPath: fileEntry.dataset.newPath,
        });
        return;
      }

      // commit row click — expand / collapse file list
      const row = e.target.closest('tr.commit-row');
      if (!row) return;

      const hash = row.dataset.hash;
      const detailId = 'detail-' + hash;
      const existing = document.getElementById(detailId);

      if (existing) {
        existing.remove();
        row.classList.remove('expanded');
        return;
      }

      if (pending.has(hash)) return;
      pending.add(hash);
      row.classList.add('expanded');

      const loadRow = document.createElement('tr');
      loadRow.id = detailId;
      loadRow.className = 'detail-row';
      loadRow.innerHTML = '<td colspan="5"><div class="file-list loading">Loading…</div></td>';
      row.insertAdjacentElement('afterend', loadRow);

      vscode.postMessage({ type: 'getFiles', hash });
    });

    window.addEventListener('message', e => {
      const { type, hash, files } = e.data;
      if (type !== 'commitFiles') return;
      pending.delete(hash);

      const detailRow = document.getElementById('detail-' + hash);
      if (!detailRow) return;

      const fileList = detailRow.querySelector('.file-list');
      if (files.length === 0) {
        fileList.innerHTML = '<span class="no-files">No files changed</span>';
        return;
      }
      fileList.classList.remove('loading');
      fileList.innerHTML = files.map(f =>
        '<span class="file-entry"' +
          ' data-hash="'     + esc(hash)        + '"' +
          ' data-status="'   + esc(f.status)    + '"' +
          ' data-old-path="' + esc(f.oldPath)   + '"' +
          ' data-new-path="' + esc(f.newPath)   + '"' +
        '>' +
          '<span class="file-status s-' + esc(f.status) + '">' + esc(f.status) + '</span>' +
          '<span class="file-name">' + esc(f.file) + '</span>' +
        '</span>'
      ).join('');
    });

    function esc(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
  </script>
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
    vscode.workspace.registerTextDocumentContentProvider(
      GitShowProvider.scheme,
      new GitShowProvider()
    ),

    vscode.window.registerTreeDataProvider('gitWorkspaceExplorer.folders', provider),

    vscode.commands.registerCommand('gitWorkspaceExplorer.refresh', () => provider.refresh()),

    vscode.commands.registerCommand(
      'gitWorkspaceExplorer.showGitInfo',
      async (folderPath: string, folderName: string) => {
        const panel = vscode.window.createWebviewPanel(
          'gitWorkspaceExplorer.info',
          `Git: ${folderName}`,
          vscode.ViewColumn.One,
          { enableScripts: true }
        );

        panel.webview.html = buildWebview(folderName, 'Loading…', []);

        const [branch, commits] = await Promise.all([
          gitBranch(folderPath),
          gitLog(folderPath),
        ]);

        panel.webview.html = buildWebview(folderName, branch, commits);

        panel.webview.onDidReceiveMessage(async msg => {
          if (msg.type === 'getFiles') {
            const files = await gitFilesChanged(folderPath, msg.hash);
            panel.webview.postMessage({ type: 'commitFiles', hash: msg.hash, files });
            return;
          }

          if (msg.type === 'openDiff') {
            const { hash, status, oldPath, newPath } = msg as {
              hash: string; status: string; oldPath: string; newPath: string;
            };
            const shortHash = hash.slice(0, 7);
            let leftUri: vscode.Uri;
            let rightUri: vscode.Uri;
            let title: string;

            switch (status) {
              case 'A':
                leftUri  = EMPTY_URI;
                rightUri = makeGitShowUri(hash, newPath, folderPath);
                title    = `${newPath} (added)`;
                break;
              case 'D':
                leftUri  = makeGitShowUri(`${hash}^`, oldPath, folderPath);
                rightUri = EMPTY_URI;
                title    = `${oldPath} (deleted)`;
                break;
              case 'R':
                leftUri  = makeGitShowUri(`${hash}^`, oldPath, folderPath);
                rightUri = makeGitShowUri(hash, newPath, folderPath);
                title    = `${oldPath} → ${newPath} (renamed @ ${shortHash})`;
                break;
              default: // M, C
                leftUri  = makeGitShowUri(`${hash}^`, oldPath, folderPath);
                rightUri = makeGitShowUri(hash, newPath, folderPath);
                title    = `${newPath} (${shortHash})`;
            }

            await vscode.workspace
              .getConfiguration('diffEditor')
              .update('renderSideBySide', true, vscode.ConfigurationTarget.Global);
            await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
          }
        });
      }
    ),

    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh())
  );
}

export function deactivate(): void {}
