import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execFileAsync = promisify(execFile);

// ─── VS Code Git API (minimal subset of the vscode.git public API) ──────────

interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitAPI;
}

interface GitAPI {
  readonly git: { readonly path: string };
  getRepository(uri: vscode.Uri): GitRepository | null;
}

interface GitRef {
  readonly type: number; // 0 = Head, 1 = RemoteHead, 2 = Tag
  readonly name?: string;
}

interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly HEAD: { name?: string } | undefined;
    readonly refs: GitRef[];
  };
  show(ref: string, path: string): Promise<string>;
  getBranches(query: { remote?: boolean }): Promise<GitRef[]>;
}

// ─── Domain types ───────────────────────────────────────────────────────────

interface Commit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
  relativeDate: string;
}

interface ChangedFile {
  status: string;   // A, M, D, R, C, U (untracked, working tree only)
  file: string;     // display label: "path" or "old → new"
  oldPath: string;  // path at parent commit (before)
  newPath: string;  // path at this commit (after)
}

interface WorkingChanges {
  staged: ChangedFile[];
  unstaged: ChangedFile[];
}

// ─── Git helpers ────────────────────────────────────────────────────────────

async function runGit(gitPath: string, cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(gitPath, args, { cwd });
  return stdout;
}

async function gitBranch(repo: GitRepository | null): Promise<string> {
  if (!repo) return '(not a git repo)';
  return repo.state.HEAD?.name ?? '(detached HEAD)';
}

async function gitBranches(repo: GitRepository | null): Promise<string[]> {
  if (!repo) return [];
  try {
    const refs = await repo.getBranches({ remote: false });
    const names = refs.map(r => r.name ?? '').filter(Boolean);
    if (names.length > 0) return names;
  } catch {}
  return repo.state.refs
    .filter(r => r.type === 0)
    .map(r => r.name ?? '')
    .filter(Boolean);
}

async function gitLog(gitPath: string, cwd: string, limit = 50, skip = 0, branch = 'HEAD'): Promise<Commit[]> {
  try {
    const format = '%H\x1f%h\x1f%s\x1f%an\x1f%ad\x1f%ar';
    const stdout = await runGit(gitPath, cwd, [
      'log', branch, `-${limit}`, `--skip=${skip}`, '--date=short', `--format=${format}`,
    ]);
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

async function gitSearchCommits(
  gitPath: string,
  cwd: string,
  query: string,
  branch: string
): Promise<Array<{ hash: string; skip: number }>> {
  const run = (args: string[]): Promise<string[]> =>
    execFileAsync(gitPath, args, { cwd })
      .then(r => r.stdout.trim().split('\n').filter(Boolean))
      .catch(() => []);

  const [byMsg, byAuthor] = await Promise.all([
    run(['log', branch, '-i', `--grep=${query}`, '--format=%H']),
    run(['log', branch, '-i', `--author=${query}`, '--format=%H']),
  ]);

  const seen = new Set<string>();
  const merged: string[] = [];
  for (const h of [...byMsg, ...byAuthor]) {
    if (!seen.has(h)) { seen.add(h); merged.push(h); }
  }

  if (/^[0-9a-f]{4,}$/i.test(query)) {
    const lines = await run(['rev-parse', '--verify', query]);
    const h = (lines[0] ?? '').trim();
    if (h.length === 40 && !seen.has(h)) { seen.add(h); merged.push(h); }
  }

  if (merged.length === 0) return [];

  const results = await Promise.all(
    merged.map(async hash => {
      const lines = await run(['rev-list', '--count', branch, `^${hash}`]);
      const skip = parseInt(lines[0] ?? '', 10);
      return isNaN(skip) ? null : { hash, skip };
    })
  );

  return (results.filter((r): r is { hash: string; skip: number } => r !== null))
    .sort((a, b) => a.skip - b.skip);
}

function parseNameStatusLine(line: string): ChangedFile {
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
}

async function gitWorkingChanges(gitPath: string, cwd: string): Promise<WorkingChanges> {
  const run = async (args: string[]): Promise<string[]> => {
    try {
      const { stdout } = await execFileAsync(gitPath, args, { cwd });
      return stdout.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };

  const [stagedLines, unstagedLines, untrackedLines] = await Promise.all([
    run(['diff', '--cached', '--name-status']),
    run(['diff', '--name-status']),
    run(['ls-files', '--others', '--exclude-standard']),
  ]);

  const staged = stagedLines.map(parseNameStatusLine);
  const unstaged = unstagedLines.map(parseNameStatusLine);
  for (const p of untrackedLines) {
    unstaged.push({ status: 'U', file: p, oldPath: p, newPath: p });
  }
  return { staged, unstaged };
}

async function gitFilesChanged(gitPath: string, cwd: string, hash: string): Promise<ChangedFile[]> {
  try {
    const stdout = await runGit(gitPath, cwd, [
      'diff-tree', '--no-commit-id', '-r', '--name-status', hash,
    ]);
    return stdout.trim().split('\n').filter(Boolean).map(parseNameStatusLine);
  } catch {
    return [];
  }
}

// ─── Git content provider ────────────────────────────────────────────────────

class GitShowProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'gitshow';

  constructor(private readonly gitApi: GitAPI, private readonly gitPath: string) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params   = new URLSearchParams(uri.query);
    const ref      = params.get('ref');
    const filePath = params.get('file') ?? '';
    const cwd      = params.get('cwd')  ?? '';
    if (ref === null || !filePath || !cwd) return '';
    try {
      if (ref === '') {
        // Index version (stage 0): git show :path. VS Code API's repo.show
        // may not accept an empty ref, so call git directly for this case.
        const { stdout } = await execFileAsync(this.gitPath, ['show', `:${filePath}`], { cwd });
        return stdout;
      }
      const repo = this.gitApi.getRepository(vscode.Uri.file(cwd));
      if (!repo) return '';
      return await repo.show(ref, filePath);
    } catch {
      return ''; // initial commit has no parent; added/deleted edge cases
    }
  }
}

function makeGitShowUri(ref: string, filePath: string, cwd: string): vscode.Uri {
  const safePath = filePath.replace(/\//g, '%2F');
  const refSegment = ref === '' ? 'INDEX' : ref;
  const query = `ref=${encodeURIComponent(ref)}&file=${encodeURIComponent(filePath)}&cwd=${encodeURIComponent(cwd)}`;
  return vscode.Uri.from({ scheme: GitShowProvider.scheme, path: `/${refSegment}/${safePath}`, query });
}

const INDEX_REF = '';

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

function buildWebview(
  folderName: string,
  branch: string,
  commits: Commit[],
  branches: string[],
  working: WorkingChanges
): string {
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
    body { margin: 0; padding: 16px; padding-bottom: 52px; }

    h1 { font-size: 1.2em; margin: 0 0 12px; display: flex; align-items: center; gap: 8px; }

    .branch-selector {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 20px;
    }
    .branch-selector select {
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      padding: 4px 8px;
      font-family: inherit;
      font-size: 0.9em;
      border-radius: 4px;
      cursor: pointer;
    }
    .branch-selector button {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 4px 10px;
      font-family: inherit;
      font-size: 0.85em;
      border-radius: 4px;
      cursor: pointer;
    }
    .branch-selector button:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .branch-selector button:disabled {
      opacity: 0.4;
      cursor: default;
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
    .s-U { color: #3fb950; }

    /* working tree rows */
    .working-row .working-dot { font-size: 0.8em; }
    .working-row[data-kind="unstaged"] .working-dot { color: #d29922; }
    .working-row[data-kind="staged"]   .working-dot { color: #3fb950; }
    .working-row .subject { font-weight: 500; }
    .working-row .count { opacity: 0.7; font-weight: normal; margin-left: 4px; }
    .working-row .count.empty { opacity: 0.4; font-style: italic; }
    .working-row .date { font-style: italic; opacity: 0.55; }
    .file-name { opacity: 0.9; }
    .stage-btn {
      background: none;
      border: 1px solid transparent;
      border-radius: 3px;
      cursor: pointer;
      font-size: 0.95em;
      font-weight: 700;
      line-height: 1;
      padding: 0 3px;
      color: inherit;
      opacity: 0.55;
      flex-shrink: 0;
    }
    .stage-btn:hover { opacity: 1; border-color: currentColor; }
    .stage-btn.add    { color: #3fb950; }
    .stage-btn.remove { color: #f85149; }
    .commit-open-btn {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 3px;
      padding: 2px 8px;
      font-family: inherit;
      font-size: 0.82em;
      cursor: pointer;
      white-space: nowrap;
    }
    .commit-open-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .commit-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.45);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 20;
    }
    .commit-overlay.hidden { display: none; }
    .commit-dialog {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 16px;
      width: min(420px, 92vw);
      display: flex;
      flex-direction: column;
      gap: 10px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.35);
    }
    .commit-dialog h3 { margin: 0; font-size: 1em; opacity: 0.85; }
    .commit-dialog textarea {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.4));
      border-radius: 4px;
      padding: 6px 8px;
      font-family: inherit;
      font-size: 0.92em;
      resize: vertical;
      outline: none;
      min-height: 80px;
    }
    .commit-dialog textarea:focus { border-color: var(--vscode-focusBorder); }
    .commit-dialog-hint { font-size: 0.78em; opacity: 0.5; margin: 0; }
    .commit-dialog-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    .commit-dialog-actions button {
      padding: 5px 16px;
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font-family: inherit;
      font-size: 0.9em;
    }
    .commit-dialog-actions .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .commit-dialog-actions .btn-primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    .commit-dialog-actions .btn-primary:disabled { opacity: 0.45; cursor: default; }
    .commit-dialog-actions .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .commit-dialog-actions .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .no-files { opacity: 0.5; font-style: italic; }

    .search-bar {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 16px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      border-top: 1px solid var(--vscode-panel-border);
      z-index: 10;
    }
    .search-bar input {
      flex: 1;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      padding: 4px 8px;
      font-family: inherit;
      font-size: 0.9em;
      border-radius: 4px;
      outline: none;
    }
    .search-bar input:focus { border-color: var(--vscode-focusBorder); }
    .search-bar button {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 4px 10px;
      font-family: inherit;
      font-size: 0.85em;
      border-radius: 4px;
      cursor: pointer;
    }
    .search-bar button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
    .search-bar button:disabled { opacity: 0.4; cursor: default; }
    .search-count { font-size: 0.85em; opacity: 0.7; white-space: nowrap; min-width: 56px; }
    .commit-row.match { background: var(--vscode-editor-findMatchHighlightBackground, rgba(255,200,0,0.18)); }
    .commit-row.current-match { background: var(--vscode-editor-findMatchBackground, rgba(255,140,0,0.45)) !important;
                                outline: 1px solid var(--vscode-editor-findMatchBorder, rgba(255,140,0,0.9)); }
  </style>
</head>
<body>
  <h1>📁 ${escHtml(folderName)}</h1>

  <div class="branch-selector">
    <select id="branch-select">
      ${branches.map(b => `<option value="${escHtml(b)}"${b === branch ? ' selected' : ''}>${b === branch ? '● ' : ''}${escHtml(b)}</option>`).join('')}
    </select>
    <button id="current-branch-btn" title="Switch to checked-out branch (${escHtml(branch)})">↩ Current</button>
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
    <tbody id="commit-tbody">
      <!-- working rows injected here by JS so every tbody re-render goes through one path -->
      ${commitRows}
      ${commits.length === 50 ? '<tr id="load-sentinel"><td colspan="5" style="text-align:center;padding:14px;opacity:0.45;font-style:italic">Loading more…</td></tr>' : ''}
    </tbody>
  </table>

  <div class="search-bar">
    <input id="search-input" type="text" placeholder="Search hash, message, author…" />
    <button id="search-btn">Search</button>
    <button id="search-prev" title="Previous match" disabled>↑</button>
    <button id="search-next" title="Next match" disabled>↓</button>
    <span class="search-count" id="search-count"></span>
  </div>

  <div id="commit-overlay" class="commit-overlay hidden">
    <div class="commit-dialog">
      <h3>Commit staged changes</h3>
      <textarea id="commit-msg-input" placeholder="Commit message (required)&#10;&#10;Ctrl+Enter to commit"></textarea>
      <p class="commit-dialog-hint">Ctrl+Enter to commit · Esc to cancel</p>
      <div class="commit-dialog-actions">
        <button id="commit-cancel-btn" class="btn-secondary">Cancel</button>
        <button id="commit-do-btn"     class="btn-primary" disabled>Commit</button>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const pending = new Set();
    let expandedHash = null;
    let offset = ${commits.length};
    let loadingMore = false;
    let exhausted = ${commits.length < 50};
    const currentBranch = '${escHtml(branch)}';
    let viewBranch = currentBranch;
    let sentinelObserver = null;
    let searchResults = [];
    let searchResultIdx = -1;
    let workingChanges = ${JSON.stringify(working)};

    function esc(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function renderRow(c) {
      return '<tr class="commit-row" data-hash="' + esc(c.hash) + '">' +
        '<td class="arrow">▶</td>' +
        '<td class="hash" title="' + esc(c.hash) + '">' + esc(c.shortHash) + '</td>' +
        '<td class="subject">' + esc(c.subject) + '</td>' +
        '<td class="author">' + esc(c.author) + '</td>' +
        '<td class="date" title="' + esc(c.date) + '">' + esc(c.relativeDate) + '</td>' +
        '</tr>';
    }

    function renderWorkingRow(kind, label) {
      const files = workingChanges[kind] || [];
      const n = files.length;
      const countHtml = n > 0
        ? '<span class="count">(' + n + ' file' + (n === 1 ? '' : 's') + ')</span>'
        : '<span class="count empty">(no changes)</span>';
      const dateCell = kind === 'staged'
        ? '<button class="commit-open-btn">Commit…</button>'
        : 'Working tree';
      return '<tr class="commit-row working-row" data-hash="__' + kind + '__" data-kind="' + kind + '">' +
        '<td class="arrow">▶</td>' +
        '<td class="hash"><span class="working-dot">●</span></td>' +
        '<td class="subject">' + label + ' ' + countHtml + '</td>' +
        '<td class="author"></td>' +
        '<td class="date">' + dateCell + '</td>' +
      '</tr>';
    }

    function renderWorkingRowsHtml() {
      return renderWorkingRow('unstaged', 'Unstaged Changes') +
             renderWorkingRow('staged',   'Staged Changes');
    }

    function renderFileEntries(hash, files, kind) {
      if (files.length === 0) {
        return '<span class="no-files">' + (kind ? 'No changes' : 'No files changed') + '</span>';
      }
      const kindAttr = kind ? ' data-kind="' + esc(kind) + '"' : '';
      const btnHtml = kind === 'unstaged'
        ? '<button class="stage-btn add" title="Stage file">+</button>'
        : kind === 'staged'
        ? '<button class="stage-btn remove" title="Unstage file">−</button>'
        : '';
      return files.map(f =>
        '<span class="file-entry"' +
          ' data-hash="'     + esc(hash)        + '"' +
          kindAttr +
          ' data-status="'   + esc(f.status)    + '"' +
          ' data-old-path="' + esc(f.oldPath)   + '"' +
          ' data-new-path="' + esc(f.newPath)   + '"' +
        '>' +
          btnHtml +
          '<span class="file-status s-' + esc(f.status) + '">' + esc(f.status) + '</span>' +
          '<span class="file-name">' + esc(f.file) + '</span>' +
        '</span>'
      ).join('');
    }

    // Inject working rows at the top of the initial tbody
    (function(){
      const tbody = document.getElementById('commit-tbody');
      tbody.insertAdjacentHTML('afterbegin', renderWorkingRowsHtml());
    })();

    function attachSentinelObserver() {
      if (sentinelObserver) sentinelObserver.disconnect();
      const s = document.getElementById('load-sentinel');
      if (!s) return;
      sentinelObserver = new IntersectionObserver(entries => {
        if (!entries[0].isIntersecting || loadingMore || exhausted) return;
        loadingMore = true;
        vscode.postMessage({ type: 'loadMore', offset, branch: viewBranch });
      }, { rootMargin: '120px' });
      sentinelObserver.observe(s);
    }
    attachSentinelObserver();

    const branchSelect = document.getElementById('branch-select');
    const currentBranchBtn = document.getElementById('current-branch-btn');

    function updateCurrentBtn() {
      currentBranchBtn.disabled = viewBranch === currentBranch;
    }
    updateCurrentBtn();

    branchSelect.addEventListener('change', () => {
      viewBranch = branchSelect.value;
      updateCurrentBtn();
      offset = 0;
      loadingMore = false;
      exhausted = false;
      expandedHash = null;
      pending.clear();
      clearSearch();
      const tbody = document.querySelector('tbody');
      tbody.innerHTML = renderWorkingRowsHtml() +
        '<tr><td colspan="5" style="text-align:center;padding:14px;opacity:0.5;font-style:italic">Loading…</td></tr>';
      vscode.postMessage({ type: 'changeBranch', branch: viewBranch });
    });

    currentBranchBtn.addEventListener('click', () => {
      branchSelect.value = currentBranch;
      branchSelect.dispatchEvent(new Event('change'));
    });

    document.addEventListener('click', e => {
      if (e.target.closest('.commit-open-btn')) {
        e.stopPropagation();
        openCommitDialog();
        return;
      }

      const stageBtn = e.target.closest('.stage-btn');
      if (stageBtn) {
        e.stopPropagation();
        const fileEntry = stageBtn.closest('.file-entry');
        const kind = fileEntry.dataset.kind;
        vscode.postMessage({
          type:    kind === 'unstaged' ? 'stageFile' : 'unstageFile',
          status:  fileEntry.dataset.status,
          oldPath: fileEntry.dataset.oldPath,
          newPath: fileEntry.dataset.newPath,
        });
        return;
      }

      const fileEntry = e.target.closest('.file-entry');
      if (fileEntry) {
        e.stopPropagation();
        const kind = fileEntry.dataset.kind;
        if (kind === 'unstaged' || kind === 'staged') {
          vscode.postMessage({
            type:    'openWorkingDiff',
            kind,
            status:  fileEntry.dataset.status,
            oldPath: fileEntry.dataset.oldPath,
            newPath: fileEntry.dataset.newPath,
          });
        } else {
          vscode.postMessage({
            type:    'openDiff',
            hash:    fileEntry.dataset.hash,
            status:  fileEntry.dataset.status,
            oldPath: fileEntry.dataset.oldPath,
            newPath: fileEntry.dataset.newPath,
          });
        }
        return;
      }

      const row = e.target.closest('tr.commit-row');
      if (!row) return;

      const hash = row.dataset.hash;
      const kind = row.dataset.kind; // set on working rows only
      const detailId = 'detail-' + hash;
      const existing = document.getElementById(detailId);

      if (existing) {
        existing.remove();
        row.classList.remove('expanded');
        expandedHash = null;
        return;
      }

      if (expandedHash && expandedHash !== hash) {
        const prevDetail = document.getElementById('detail-' + expandedHash);
        if (prevDetail) prevDetail.remove();
        const prevRow = document.querySelector('tr.commit-row[data-hash="' + expandedHash + '"]');
        if (prevRow) prevRow.classList.remove('expanded');
      }

      if (pending.has(hash)) return;
      row.classList.add('expanded');
      expandedHash = hash;

      const loadRow = document.createElement('tr');
      loadRow.id = detailId;
      loadRow.className = 'detail-row';

      if (kind) {
        // Working row — files already known locally, render immediately
        const files = workingChanges[kind] || [];
        loadRow.innerHTML = '<td colspan="5"><div class="file-list">' +
          renderFileEntries(hash, files, kind) + '</div></td>';
        row.insertAdjacentElement('afterend', loadRow);
      } else {
        pending.add(hash);
        loadRow.innerHTML = '<td colspan="5"><div class="file-list loading">Loading…</div></td>';
        row.insertAdjacentElement('afterend', loadRow);
        vscode.postMessage({ type: 'getFiles', hash });
      }
    });

    window.addEventListener('message', e => {
      const { type, hash, files, commits: batch } = e.data;

      if (type === 'commitDone') {
        closeCommitDialog();
        commitDoBtn.textContent = 'Commit';
        return;
      }

      if (type === 'searchResults') {
        if (e.data.branch !== viewBranch) return;
        searchResults = e.data.results ?? [];
        if (searchResults.length === 0) { searchCount.textContent = 'No matches'; return; }
        searchPrev.disabled = false;
        searchNext.disabled = false;
        goToMatch(0);
        return;
      }

      if (type === 'windowCommits') {
        if (e.data.branch !== viewBranch) return;
        const { commits: batch, windowSkip, anchor } = e.data;
        const tbody = document.querySelector('tbody');
        offset = windowSkip + (batch?.length ?? 0);
        exhausted = (batch?.length ?? 0) < 50;
        const sentinelHtml = exhausted ? '' : '<tr id="load-sentinel"><td colspan="5" style="text-align:center;padding:14px;opacity:0.45;font-style:italic">Loading more…</td></tr>';
        tbody.innerHTML = renderWorkingRowsHtml() + (batch ?? []).map(renderRow).join('') + sentinelHtml;
        if (!exhausted) attachSentinelObserver();
        const anchorRow = document.querySelector('tr.commit-row[data-hash="' + esc(anchor) + '"]');
        if (anchorRow) {
          anchorRow.classList.add('current-match');
          anchorRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
        return;
      }

      if (type === 'branchCommits') {
        if (e.data.branch !== viewBranch) return;
        const tbody = document.querySelector('tbody');
        if (!batch || batch.length === 0) {
          exhausted = true;
          tbody.innerHTML = renderWorkingRowsHtml() +
            '<tr><td colspan="5" class="empty">No commits found</td></tr>';
          return;
        }
        offset = batch.length;
        exhausted = batch.length < 50;
        const sentinelHtml = exhausted ? '' : '<tr id="load-sentinel"><td colspan="5" style="text-align:center;padding:14px;opacity:0.45;font-style:italic">Loading more…</td></tr>';
        tbody.innerHTML = renderWorkingRowsHtml() + batch.map(renderRow).join('') + sentinelHtml;
        if (!exhausted) attachSentinelObserver();
        return;
      }

      if (type === 'moreCommits') {
        if (e.data.branch !== viewBranch) return;
        loadingMore = false;
        const sentinel = document.getElementById('load-sentinel');
        if (!batch || batch.length === 0) {
          exhausted = true;
          if (sentinel) sentinel.remove();
          return;
        }
        offset += batch.length;
        if (sentinel) sentinel.insertAdjacentHTML('beforebegin', batch.map(renderRow).join(''));
        if (batch.length < 50) {
          exhausted = true;
          if (sentinel) sentinel.remove();
        }
        return;
      }

      if (type === 'workingChanges') {
        workingChanges = e.data.working;
        for (const k of ['unstaged', 'staged']) {
          const row = document.querySelector('tr.working-row[data-kind="' + k + '"]');
          if (!row) continue;
          const n = (workingChanges[k] || []).length;
          const label = k === 'unstaged' ? 'Unstaged Changes' : 'Staged Changes';
          const countHtml = n > 0
            ? '<span class="count">(' + n + ' file' + (n === 1 ? '' : 's') + ')</span>'
            : '<span class="count empty">(no changes)</span>';
          row.querySelector('.subject').innerHTML = label + ' ' + countHtml;
          const detailRow = document.getElementById('detail-__' + k + '__');
          if (detailRow) {
            detailRow.querySelector('.file-list').innerHTML =
              renderFileEntries('__' + k + '__', workingChanges[k] || [], k);
          }
        }
        return;
      }

      if (type !== 'commitFiles') return;
      pending.delete(hash);

      const detailRow = document.getElementById('detail-' + hash);
      if (!detailRow) return;

      const fileList = detailRow.querySelector('.file-list');
      fileList.classList.remove('loading');
      fileList.innerHTML = renderFileEntries(hash, files, null);
    });

    const searchInput = document.getElementById('search-input');
    const searchBtn   = document.getElementById('search-btn');
    const searchPrev  = document.getElementById('search-prev');
    const searchNext  = document.getElementById('search-next');
    const searchCount = document.getElementById('search-count');

    function clearSearch() {
      document.querySelectorAll('tr.commit-row.current-match').forEach(r =>
        r.classList.remove('current-match')
      );
      searchResults = [];
      searchResultIdx = -1;
      searchCount.textContent = '';
      searchPrev.disabled = true;
      searchNext.disabled = true;
    }

    function doSearch() {
      clearSearch();
      const q = searchInput.value.trim();
      if (!q) return;
      searchCount.textContent = 'Searching…';
      vscode.postMessage({ type: 'search', query: q, branch: viewBranch });
    }

    function goToMatch(idx) {
      if (searchResults.length === 0) return;
      document.querySelectorAll('tr.commit-row.current-match').forEach(r => r.classList.remove('current-match'));
      searchResultIdx = ((idx % searchResults.length) + searchResults.length) % searchResults.length;
      searchCount.textContent = (searchResultIdx + 1) + ' / ' + searchResults.length;
      const { hash, skip } = searchResults[searchResultIdx];
      const row = document.querySelector('tr.commit-row[data-hash="' + esc(hash) + '"]');
      if (row) {
        row.classList.add('current-match');
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } else {
        vscode.postMessage({ type: 'loadWindow', skip: Math.max(0, skip - 24), branch: viewBranch, anchor: hash });
      }
    }

    searchBtn.addEventListener('click', doSearch);
    searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
    searchPrev.addEventListener('click', () => goToMatch(searchResultIdx - 1));
    searchNext.addEventListener('click', () => goToMatch(searchResultIdx + 1));

    // ── Commit dialog ──────────────────────────────────────────────────────
    const commitOverlay  = document.getElementById('commit-overlay');
    const commitMsgInput = document.getElementById('commit-msg-input');
    const commitDoBtn    = document.getElementById('commit-do-btn');
    const commitCancelBtn= document.getElementById('commit-cancel-btn');

    function openCommitDialog() {
      commitMsgInput.value = '';
      commitDoBtn.disabled = true;
      commitOverlay.classList.remove('hidden');
      commitMsgInput.focus();
    }

    function closeCommitDialog() {
      commitOverlay.classList.add('hidden');
    }

    commitMsgInput.addEventListener('input', () => {
      commitDoBtn.disabled = commitMsgInput.value.trim() === '';
    });

    commitMsgInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (!commitDoBtn.disabled) commitDoBtn.click();
      }
      if (e.key === 'Escape') closeCommitDialog();
    });

    commitCancelBtn.addEventListener('click', closeCommitDialog);

    commitOverlay.addEventListener('click', e => {
      if (e.target === commitOverlay) closeCommitDialog();
    });

    commitDoBtn.addEventListener('click', () => {
      const msg = commitMsgInput.value.trim();
      if (!msg) return;
      commitDoBtn.disabled = true;
      commitDoBtn.textContent = 'Committing…';
      vscode.postMessage({ type: 'commitStaged', message: msg });
    });

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

// ─── Diff helpers ────────────────────────────────────────────────────────────

function diffViewColumn(): vscode.ViewColumn {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputTextDiff) {
        const { original, modified } = tab.input as vscode.TabInputTextDiff;
        if (original.scheme === GitShowProvider.scheme ||
            modified.scheme === GitShowProvider.scheme) {
          return group.viewColumn;
        }
      }
    }
  }
  return vscode.ViewColumn.Beside;
}

async function openDiffEditor(left: vscode.Uri, right: vscode.Uri, title: string): Promise<void> {
  await Promise.all([
    vscode.workspace.getConfiguration('diffEditor')
      .update('renderSideBySide', true, vscode.ConfigurationTarget.Global),
    vscode.workspace.getConfiguration('workbench.editor')
      .update('openSideBySideDirection', 'down', vscode.ConfigurationTarget.Global),
  ]);
  await vscode.commands.executeCommand('vscode.diff', left, right, title, { viewColumn: diffViewColumn() });
}

// ─── Activation ───────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const gitExt = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!gitExt) {
    vscode.window.showErrorMessage('Git Workspace Explorer requires the built-in VS Code Git extension.');
    return;
  }
  if (!gitExt.isActive) {
    await gitExt.activate();
  }
  const gitApi = gitExt.exports.getAPI(1);
  const gitPath = gitApi.git.path;

  const provider = new WorkspaceFoldersProvider();

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      GitShowProvider.scheme,
      new GitShowProvider(gitApi, gitPath)
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
          { enableScripts: true, retainContextWhenHidden: true }
        );

        panel.webview.html = buildWebview(folderName, 'Loading…', [], [], { staged: [], unstaged: [] });

        const repo = gitApi.getRepository(vscode.Uri.file(folderPath));

        const [branch, commits, branches, working] = await Promise.all([
          gitBranch(repo),
          gitLog(gitPath, folderPath),
          gitBranches(repo),
          gitWorkingChanges(gitPath, folderPath),
        ]);

        panel.webview.html = buildWebview(folderName, branch, commits, branches, working);

        panel.webview.onDidReceiveMessage(async msg => {
          if (msg.type === 'search') {
            const b = msg.branch ?? branch;
            const results = await gitSearchCommits(gitPath, folderPath, msg.query, b);
            panel.webview.postMessage({ type: 'searchResults', results, branch: b });
            return;
          }

          if (msg.type === 'loadWindow') {
            const b = msg.branch ?? branch;
            const commits = await gitLog(gitPath, folderPath, 50, msg.skip, b);
            panel.webview.postMessage({ type: 'windowCommits', commits, windowSkip: msg.skip, branch: b, anchor: msg.anchor });
            return;
          }

          if (msg.type === 'changeBranch') {
            const commits = await gitLog(gitPath, folderPath, 50, 0, msg.branch);
            panel.webview.postMessage({ type: 'branchCommits', commits, branch: msg.branch });
            return;
          }

          if (msg.type === 'loadMore') {
            const b = msg.branch ?? branch;
            const commits = await gitLog(gitPath, folderPath, 50, msg.offset, b);
            panel.webview.postMessage({ type: 'moreCommits', commits, branch: b });
            return;
          }

          if (msg.type === 'getFiles') {
            const files = await gitFilesChanged(gitPath, folderPath, msg.hash);
            panel.webview.postMessage({ type: 'commitFiles', hash: msg.hash, files });
            return;
          }

          if (msg.type === 'stageFile') {
            const { status, oldPath, newPath } = msg as { status: string; oldPath: string; newPath: string };
            try {
              // For deletions the file is gone; git add still records the removal.
              await runGit(gitPath, folderPath, ['add', '--', status === 'D' ? oldPath : newPath]);
            } catch {}
            const working = await gitWorkingChanges(gitPath, folderPath);
            panel.webview.postMessage({ type: 'workingChanges', working });
            return;
          }

          if (msg.type === 'unstageFile') {
            const { status, oldPath, newPath } = msg as { status: string; oldPath: string; newPath: string };
            try {
              const paths = (status === 'R' || status === 'C') ? [oldPath, newPath] : [newPath];
              await runGit(gitPath, folderPath, ['restore', '--staged', '--', ...paths]);
            } catch {}
            const working = await gitWorkingChanges(gitPath, folderPath);
            panel.webview.postMessage({ type: 'workingChanges', working });
            return;
          }

          if (msg.type === 'commitStaged') {
            try {
              await runGit(gitPath, folderPath, ['commit', '-m', msg.message as string]);
            } catch {}
            panel.webview.postMessage({ type: 'commitDone' });
            const working = await gitWorkingChanges(gitPath, folderPath);
            panel.webview.postMessage({ type: 'workingChanges', working });
            return;
          }

          if (msg.type === 'openWorkingDiff') {
            const { kind, status, oldPath, newPath } = msg as {
              kind: 'unstaged' | 'staged'; status: string; oldPath: string; newPath: string;
            };
            const workingUri = (p: string) => vscode.Uri.file(path.join(folderPath, p));
            let leftUri: vscode.Uri;
            let rightUri: vscode.Uri;
            let title: string;

            if (kind === 'unstaged') {
              // HEAD → working tree
              if (status === 'U') {
                leftUri  = EMPTY_URI;
                rightUri = workingUri(newPath);
                title    = `${newPath} (untracked)`;
              } else if (status === 'D') {
                leftUri  = makeGitShowUri('HEAD', oldPath, folderPath);
                rightUri = EMPTY_URI;
                title    = `${oldPath} (deleted, unstaged)`;
              } else {
                leftUri  = makeGitShowUri('HEAD', newPath, folderPath);
                rightUri = workingUri(newPath);
                title    = `${newPath} (unstaged)`;
              }
            } else {
              // HEAD → index
              if (status === 'A') {
                leftUri  = EMPTY_URI;
                rightUri = makeGitShowUri(INDEX_REF, newPath, folderPath);
                title    = `${newPath} (added, staged)`;
              } else if (status === 'D') {
                leftUri  = makeGitShowUri('HEAD', oldPath, folderPath);
                rightUri = EMPTY_URI;
                title    = `${oldPath} (deleted, staged)`;
              } else if (status === 'R') {
                leftUri  = makeGitShowUri('HEAD', oldPath, folderPath);
                rightUri = makeGitShowUri(INDEX_REF, newPath, folderPath);
                title    = `${oldPath} → ${newPath} (renamed, staged)`;
              } else {
                leftUri  = makeGitShowUri('HEAD', newPath, folderPath);
                rightUri = makeGitShowUri(INDEX_REF, newPath, folderPath);
                title    = `${newPath} (staged)`;
              }
            }

            await openDiffEditor(leftUri, rightUri, title);
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

            await openDiffEditor(leftUri, rightUri, title);
          }
        });
      }
    ),

    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh())
  );
}

export function deactivate(): void {}
