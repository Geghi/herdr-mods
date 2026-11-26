// A VS Code-style workbench tab: Explorer + editor, Changes, Compare (branch vs base), Git Graph.
// Works on this machine and on ssh machines (reads with readTextFile {on}, git and saves through exec there).
import { View, div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { spaces, panes, focused, run, home, exec, readTextFile, writeTextFile, theme, settings, window as hwin, props, shared, nextCommand, checking } from "herdr";
import { gitIn, repoRoot, branches, workingChanges, pull, stage, unstage, discard, changedFiles, mergeBase, aheadBehind, fileDiff, unifiedRows, splitRows, textAsAdded, commits, layoutGraph, buildTree, relTime, EMPTY_TREE } from "./git.js";
import { fileIcon } from "./icons.js";
import { languageOf } from "./langs.js";

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js", toml: "yaml", yml: "yaml", jsonc: "json", svelte: "html", vue: "html", htm: "html", md: "markdown" };
const NAMES = { js: "JavaScript", ts: "TypeScript", tsx: "TypeScript JSX", jsx: "JavaScript JSX", py: "Python", rs: "Rust", go: "Go", json: "JSON", md: "Markdown", html: "HTML", css: "CSS", yaml: "YAML", yml: "YAML", toml: "TOML", sh: "Shell", php: "PHP", java: "Java", kt: "Kotlin", c: "C", h: "C", cpp: "C++", cs: "C#", rb: "Ruby", sql: "SQL", dart: "Dart", swift: "Swift" };
const PER_FOLDER = 500;
const base = p => p.split(/[\\/]/).pop();
const ext = p => { const b = base(p); return b.includes(".") ? b.split(".").pop().toLowerCase() : "txt"; };
const psQuote = s => "'" + s.replace(/['‘’‚‛]/g, "$&$&") + "'";

// ---- folders (same approach as the Files panel) ----
async function directory(path, on) {
  const windowsDirectory = async () => {
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } " + psQuote(path)], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && hwin()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

// ---- new files and folders (fails if the name is taken; parent folders are made as needed) ----
async function createEntry(path, folder, on) {
  const windows = async () => {
    const r = await exec("powershell", ["-NoProfile", "-Command", "& { param($p, $d) if (Test-Path -LiteralPath $p) { throw 'Already exists' }; if ($d -eq 'd') { [void][IO.Directory]::CreateDirectory($p) } else { [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($p)); [IO.File]::WriteAllBytes($p, [byte[]]@()) } } " + psQuote(path) + (folder ? " d" : " f")], { on });
    if (r.code !== 0) throw new Error(r.stderr.trim().split(/\r?\n/)[0] || "Couldn't create it");
  };
  if (!on && hwin()?.platform === "windows") return windows();
  const script = 'if [ -e "$1" ] || [ -L "$1" ]; then echo "Already exists" >&2; exit 1; fi; ' +
    'if [ "$2" = d ]; then mkdir -p -- "$1"; else mkdir -p -- "$(dirname -- "$1")" && set -C && : > "$1"; fi';
  let r;
  try { r = await exec("sh", ["-c", script, "code", path, folder ? "d" : "f"], { on }); }
  catch (e) {
    if (on && String(e).includes("program not found")) return windows();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || "Couldn't create it");
}

// ---- saving ----
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function utf8Base64(text) {
  const bytes = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | c >> 6, 0x80 | c & 63);
    else if (c < 0x10000) bytes.push(0xe0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63);
    else bytes.push(0xf0 | c >> 18, 0x80 | c >> 12 & 63, 0x80 | c >> 6 & 63, 0x80 | c & 63);
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = bytes[i] << 16 | (bytes[i + 1] ?? 0) << 8 | (bytes[i + 2] ?? 0);
    out += B64[n >> 18 & 63] + B64[n >> 12 & 63] + (i + 1 < bytes.length ? B64[n >> 6 & 63] : "=") + (i + 2 < bytes.length ? B64[n & 63] : "=");
  }
  return { data: out, bytes: bytes.length };
}

const CHUNK = 60000; // Keeps each argument well under Linux's 128 KiB per-argument limit.
async function saveRemote(path, text, on) {
  const { data, bytes } = utf8Base64(text);
  const tmp = `${path}.herdr-save-${Date.now().toString(36)}`;
  const chunks = [];
  for (let i = 0; i < data.length; i += CHUNK) chunks.push(data.slice(i, i + CHUNK));
  if (!chunks.length) chunks.push("");
  const check = r => { if (r.code !== 0) throw new Error(r.stderr.trim() || "Save failed"); };
  let windows = false;
  try {
    check(await exec("sh", ["-c", ': > "$1"', "code", tmp + ".b64"], { on }));
  } catch (e) {
    if (!String(e).includes("program not found")) throw e;
    windows = true;
  }
  if (!windows) {
    for (const c of chunks) check(await exec("sh", ["-c", 'printf %s "$2" >> "$1"', "code", tmp + ".b64", c], { on }));
    check(await exec("sh", ["-c",
      'b="$1.b64"; t="$1.new"; { base64 -d < "$b" 2>/dev/null || base64 -D < "$b"; } > "$t"; rm -f "$b"; ' +
      'n=$(wc -c < "$t" | tr -d " "); if [ "$n" != "$3" ]; then rm -f "$t"; echo "Save check failed (size $n, expected $3)" >&2; exit 1; fi; ' +
      'cat "$t" > "$2" && rm -f "$t"', "code", tmp, path, String(bytes)], { on }));
    return;
  }
  const ps = cmd => exec("powershell", ["-NoProfile", "-Command", cmd], { on });
  const b64 = psQuote(tmp + ".b64");
  check(await ps(`Set-Content -LiteralPath ${b64} -Value '' -NoNewline`));
  for (const c of chunks) check(await ps(`Add-Content -LiteralPath ${b64} -Value '${c}' -NoNewline`));
  check(await ps(`$b = [Convert]::FromBase64String((Get-Content -LiteralPath ${b64} -Raw)); if ($b.Length -ne ${bytes}) { throw 'Save check failed' }; [IO.File]::WriteAllBytes(${psQuote(path)}, $b); Remove-Item -LiteralPath ${b64}`));
}

// ---- the view ----

const VIEWS = [
  { id: "explorer", label: "Explorer", icon: "files" },
  { id: "changes", label: "Changes", icon: "git-branch" },
  { id: "compare", label: "Compare", icon: "git-compare" },
  { id: "graph", label: "History", icon: "git-graph" },
];
const STATUS = { A: "Added", M: "Modified", D: "Deleted", U: "Conflict" };
const shortSha = s => (s || "").slice(0, 7);
const mono = () => settings().font_family || "JetBrains Mono";

export default class Code extends View {
  init(_props, cx) {
    const space = spaces().find(s => s.id === props()?.space) ?? spaces().find(s => s.active);
    this.space = props()?.space ?? space?.id ?? null;
    this.on = space?.machine ?? null; this.root = this.spaceFolder();
    this.docs = []; this.active = -1; this.seen = 0;
    this.entries = new Map(); this.folders = new Set(); this.treeError = null;
    this.sidebar = true; this.message = null; this.view = "explorer";
    this.collapsed = new Set(); this.split = false; this.fullFile = false;
    this.repo = null;                                   // { root, on, current, base, list }
    this.work = { staged: [], unstaged: [], loading: false, error: null, hasHead: true, at: 0 };
    this.changesTree = true; this.sideW = 300; this.hover = null; this.rowMenu = null; this.confirm = null;
    this.cmp = { base: null, head: null, live: true, files: [], loading: false, error: null, info: null, from: null, to: null };
    this.graph = { all: false, limit: 400, commits: [], layout: null, loading: false, error: null, selected: null, detail: null };
    this.picker = null;
    this.commitMsg = InputState.new({ placeholder: "Commit message (commits all changes)" });
    this.commitMsg.on("submit", (_e, cx) => this.commitAll(cx));
    this.treeSel = null; this.creating = null;          // explorer selection { rel, dir }; new entry { kind, dir, busy, error }
    this.newName = InputState.new({ placeholder: "Name (a/b.txt makes folders)" });
    this.newName.on("submit", (_e, cx) => this.finishCreate(cx));
    this.newName.on("blur", (_e, cx) => this.cancelCreate(cx));
    this.pickerFilter = InputState.new({ placeholder: "Filter branches…" });
    this.pickerFilter.on("change", (_e, cx) => cx.notify());
    this.graphScroll = VirtualListScrollHandle.new();
    this.diffScroll = VirtualListScrollHandle.new();
    this.sel = null;                                    // diff line selection { id, a, b, side, drag }
    this.find = { open: false, query: "", at: 0, hits: [], rows: null, q: null, focused: false };
    this.findInput = InputState.new({ placeholder: "Find in diff" });
    this.findInput.on("change", (_e, cx) => { this.find.query = this.findInput.value(); this.find.at = 0; this.jumpHit(0); cx.notify(); });
    this.findInput.on("submit", (_e, cx) => { this.jumpHit(1); cx.notify(); });
    this.findInput.on("focus", (_e, cx) => { this.find.focused = true; cx.notify(); });
    this.findInput.on("blur", (_e, cx) => { this.find.focused = false; cx.notify(); });
    this.handle = cx.focus_handle();
    this.branchMenu = false;
    this.branchFilter = InputState.new({ placeholder: "Switch to branch…" });
    this.branchFilter.on("change", (_e, cx) => cx.notify());
    this.newBranch = InputState.new({ placeholder: "New branch name (from current)" });
    this.newBranch.on("submit", (_e, cx) => this.createBranch(cx));
    if (checking()) return;
    this.dedupeUntil = props()?.dedupe ? Date.now() + 3000 : 0;
    try {
      const saved = JSON.parse(localStorage.getItem(`session:${this.space}`) || "null");
      if (saved && (saved.on ?? null) === this.on) {
        if (saved.root === this.root) this.folders = new Set(saved.folders ?? []);
        for (const d of saved.docs ?? []) this.open(d.path, d.on ?? null, cx, false);
        if (saved.active >= 0) this.active = Math.min(saved.active, this.docs.length - 1);
        if (VIEWS.some(v => v.id === saved.view)) this.view = saved.view;
        this.split = Boolean(saved.split);
        this.fullFile = Boolean(saved.fullFile);
        if (saved.sideW) this.sideW = saved.sideW;
        if (saved.changesTree === false) this.changesTree = false;
      }
    } catch {}
    // tab.new props: open (a path or a list, relative to the space folder) and view.
    const p = props() ?? {};
    for (const f of [].concat(p.open ?? [])) this.open(/^([\\/]|[A-Za-z]:)/.test(f) ? f : `${this.root}/${f}`, this.on, cx, false);
    if (VIEWS.some(v => v.id === p.view)) this.view = p.view;
    this.loadTree(cx);
    this.loadRepo(cx);
    cx.timer.every(5000, cx => {
      if (hwin()?.active === false || !this.repo) return;
      if (this.view === "changes" || Date.now() - this.work.at > 30000) this.loadWork(cx);
    });
    cx.spawn(async cx => {
      for (;;) {
        const c = await nextCommand();
        if (c === "save") this.save(this.active, cx, false);
        else if (c === "close") {
          this.close(this.active, cx);
          // Keep the keyboard in the editor, so Ctrl+F4 again closes the next file, not the tab.
          const d = this.docs[this.active];
          if (d?.state && !this.docs.some(x => x.confirmClose)) d.state.focus(); else this.handle.focus();
        }
        else if (c === "pull") this.pullBranch(cx);
        else if (c === "explorer") this.sidebar = !this.sidebar;
        else if (c === "focus") { const d = this.docs[this.active]; if (d?.state) d.state.focus(); else this.handle.focus(); }
        cx.notify();
      }
    });
  }

  spaceFolder() {
    const space = spaces().find(s => s.id === this.space);
    if (!space) return null;
    const list = panes();
    for (const tab of space.tabs) {
      const p = list.find(p => p.tab === tab.id && p.terminal && p.cwd);
      if (p) return p.cwd;
    }
    return space.folder || null;
  }

  persist() {
    if (checking()) return;
    try {
      const files = this.docs.filter(d => d.kind === "file");
      const cur = this.docs[this.active];
      localStorage.setItem(`session:${this.space}`, JSON.stringify({ root: this.root, on: this.on, folders: [...this.folders],
        docs: files.map(d => ({ path: d.path, on: d.on })), active: cur?.kind === "file" ? files.indexOf(cur) : -1,
        view: this.view, split: this.split, fullFile: this.fullFile, sideW: this.sideW, changesTree: this.changesTree }));
    } catch {}
  }

  setView(id, cx) {
    this.view = id; this.sidebar = true; this.picker = null;
    if (id === "changes") this.loadWork(cx);
    if (id === "compare" && this.repo && !this.cmp.files.length) this.loadCompare(cx);
    if (id === "graph") { if (!this.docs.some(d => d.kind === "graph")) this.graph.all = false; this.openGraph(cx); }
    this.persist();
  }

  // ---- repository ----
  git() { return gitIn(this.repo.root, this.repo.on); }

  loadRepo(cx) {
    const cwd = this.root, on = this.on;
    if (!cwd) return;
    cx.spawn(async cx => {
      const root = await repoRoot(cwd, on);
      if (this.root !== cwd || this.on !== on) return;
      if (!root) { this.repo = null; cx.notify(); return; }
      try {
        const b = await branches(gitIn(root, on));
        if (this.root !== cwd || this.on !== on) return;
        const same = this.repo?.root === root && this.repo?.on === on;
        this.repo = { root, on, ...b };
        if (!same) {
          this.cmp = { ...this.cmp, base: b.base, head: b.current, files: [], info: null, error: null };
          this.graph = { ...this.graph, commits: [], layout: null, selected: null, detail: null };
        }
        this.loadWork(cx);
        if (this.view === "compare") this.loadCompare(cx);
        if (this.docs.some(d => d.kind === "graph")) this.loadGraph(cx);
      } catch { if (this.root === cwd && this.on === on) this.repo = null; }
      cx.notify();
    });
  }

  loadWork(cx) {
    const repo = this.repo;
    if (!repo || this.loadingWorkRepo === repo) return;
    this.loadingWorkRepo = repo;
    this.work.loading = true;
    cx.spawn(async cx => {
      try {
        const r = await workingChanges(gitIn(repo.root, repo.on));
        if (this.repo !== repo) return;
        this.work = { ...this.work, ...r, error: null };
      } catch (e) {
        if (this.repo === repo) this.work.error = String(e.message ?? e);
      } finally {
        if (this.loadingWorkRepo === repo) {
          this.loadingWorkRepo = null;
          this.work.loading = false;
          this.work.at = Date.now();
          cx.notify();
        }
      }
    });
  }

  commitAll(cx) {
    const msg = this.commitMsg.value().trim();
    if (!msg || !this.repo || this.work.busy || this.switching) return;
    const git = this.git(), stagedOnly = this.work.staged.length > 0;
    this.work.busy = "commit"; this.work.note = null; cx.notify();
    cx.spawn(async cx => {
      try {
        if (!stagedOnly) await git(["add", "-A"]);
        await git(["commit", "-m", msg]);
        this.commitMsg.set_value("");
        this.work.note = "Committed ✓";
      } catch (e) { this.work.note = `Commit failed: ${String(e.message ?? e).slice(0, 200)}`; }
      finally { this.work.busy = false; this.loadWork(cx); this.loadRepo(cx); cx.notify(); }
    });
  }

  pullBranch(cx) {
    if (!this.repo || this.work.busy || this.switching) return;
    const git = this.git(), repo = this.repo;
    const root = this.root, on = this.on;
    const sameFolder = () => this.root === root && this.on === on;
    this.work.busy = "pull";
    this.view = "changes";
    this.sidebar = true;
    this.picker = null;
    this.persist();
    this.work.note = null;
    this.rowMenu = null;
    this.confirm = null;
    cx.spawn(async cx => {
      try {
        await pull(git);
        if (!sameFolder()) return;
        this.work.note = "Pull complete.";
        const prefix = repo.root.replace(/\\/g, "/").replace(/\/$/, "") + "/";
        for (const [i, doc] of this.docs.entries()) {
          if (doc.kind === "file" && doc.on === repo.on && doc.path.replace(/\\/g, "/").startsWith(prefix)) {
            this.reload(i, cx, true);
          }
        }
        this.loadTree(cx);
      } catch (e) {
        if (sameFolder()) {
          const detail = String(e.message ?? e);
          const reason = /not possible to fast-forward|fast forward non possibile/i.test(detail) ? "The branches have diverged."
            : /no tracking information|no such ref was fetched|not currently on a branch|non ci sono informazioni di tracciamento|non sei su un branch/i.test(detail) ? "Check that this branch tracks an upstream."
            : /would be overwritten|sarebbero sovrascritt/i.test(detail) ? "Your local changes overlap with incoming changes."
            : "Check your connection, Git credentials, and repository status.";
          this.work.note = `Pull failed: ${reason}`;
        }
      } finally {
        this.work.busy = false;
        if (sameFolder()) this.loadRepo(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  // Runs a git change on the working copy, then refreshes the lists.
  gitAction(label, fn, cx) {
    if (!this.repo || this.work.busy || this.switching) return;
    const git = this.git();
    this.work.busy = "change";
    this.rowMenu = null; this.confirm = null;
    cx.spawn(async cx => {
      try { await fn(git); this.work.note = null; }
      catch (e) { this.work.note = `${label} failed: ${String(e.message ?? e).slice(0, 200)}`; }
      finally { this.work.busy = false; this.loadWork(cx); cx.notify(); }
    });
    cx.notify();
  }

  askDiscard(files, cx) {
    const n = files.length, fresh = files.filter(f => f.untracked).length;
    this.confirm = {
      title: n === 1 ? `Discard changes in ${base(files[0].path)}?` : `Discard changes in ${n} files?`,
      detail: fresh ? `${fresh} untracked file${fresh > 1 ? "s" : ""} will be DELETED. This can't be undone.` : "This can't be undone.",
      label: n === 1 ? "Discard" : "Discard all",
      run: cx => this.gitAction("Discard", git => discard(git, files), cx),
    };
    this.rowMenu = null; cx.notify();
  }

  // Appends a pattern to the repo's .gitignore (here: safe write; ssh: append through sh).
  ignore(pattern, cx) {
    const repo = this.repo;
    if (!repo) return;
    this.rowMenu = null;
    cx.spawn(async cx => {
      const file = `${repo.root}/.gitignore`;
      try {
        if (repo.on) {
          const r = await exec("sh", ["-c", 'f="$1/.gitignore"; if [ -s "$f" ] && [ -n "$(tail -c1 "$f")" ]; then echo >> "$f"; fi; printf "%s\\n" "$2" >> "$f"', "x", repo.root, pattern], { on: repo.on });
          if (r.code !== 0) throw new Error(r.stderr);
        } else {
          const old = await readTextFile(file);
          const text = (old ?? "") + (old && !old.endsWith("\n") ? "\n" : "") + pattern + "\n";
          await writeTextFile(file, text, old);
        }
        this.work.note = `Added ${pattern} to .gitignore`;
      } catch (e) { this.work.note = `.gitignore failed: ${String(e.message ?? e).slice(0, 200)}`; }
      finally { this.loadWork(cx); cx.notify(); }
    });
    cx.notify();
  }

  loadCompare(cx) {
    if (!this.repo) return;
    const repo = this.repo, c = this.cmp, git = this.git();
    const base = c.base, head = c.head;
    const live = c.live && head === repo.current;
    c.loading = true; c.error = null; cx.notify();
    const ticket = c.ticket = (c.ticket ?? 0) + 1;
    cx.spawn(async cx => {
      try {
        const from = await mergeBase(git, base, head === "HEAD" ? "HEAD" : head);
        const to = live ? null : head;
        const [files, ab] = await Promise.all([changedFiles(git, from, to), aheadBehind(git, base, head).catch(() => null)]);
        if (this.cmp.ticket !== ticket || this.repo !== repo) return;
        Object.assign(this.cmp, { files, from, to, info: ab, error: null });
      } catch (e) { if (this.cmp.ticket === ticket) { this.cmp.error = String(e.message ?? e); this.cmp.files = []; } }
      finally { if (this.cmp.ticket === ticket) { this.cmp.loading = false; cx.notify(); } }
    });
  }

  openGraph(cx) {
    let i = this.docs.findIndex(d => d.kind === "graph");
    if (i < 0) { this.docs.push({ kind: "graph" }); i = this.docs.length - 1; }
    this.active = i;
    if (!this.graph.commits.length) this.loadGraph(cx);
  }

  loadGraph(cx) {
    if (!this.repo) return;
    const repo = this.repo, g = this.graph;
    g.loading = true; g.error = null;
    cx.spawn(async cx => {
      try {
        const list = await commits(gitIn(repo.root, repo.on), g.all, g.limit);
        if (this.repo !== repo) return;
        g.commits = list; g.layout = layoutGraph(list);
      } catch (e) { g.error = String(e.message ?? e); }
      finally { g.loading = false; cx.notify(); }
    });
    cx.notify();
  }

  selectCommit(c, cx) {
    const g = this.graph;
    g.selected = c.sha; g.detail = { commit: c, files: null, error: null };
    const repo = this.repo, from = c.parents[0] ?? EMPTY_TREE;
    cx.spawn(async cx => {
      try {
        const files = await changedFiles(gitIn(repo.root, repo.on), from, c.sha);
        if (g.selected === c.sha) g.detail.files = files;
      } catch (e) { if (g.selected === c.sha) g.detail.error = String(e.message ?? e); }
      finally { cx.notify(); }
    });
    cx.notify();
  }

  jumpTo(name, cx) {
    const g = this.graph, b = this.repo?.list.find(x => x.name === name);
    const i = g.commits.findIndex(c => b && c.sha.startsWith(b.sha));
    this.openGraph(cx);
    if (i >= 0) { this.selectCommit(g.commits[i], cx); this.graphScroll.scroll_to_item(i, "center"); }
  }

  // ---- diffs ----
  openDiff({ from, to, path, status, untracked, title }, cx, keep) {
    const repo = this.repo;
    if (!repo) return;
    const key = `${from}|${to}|${path}`;
    let i = this.docs.findIndex(d => d.kind === "diff" && d.key === key);
    if (i >= 0) { if (keep) this.docs[i].preview = false; this.active = i; cx.notify(); return; }
    const doc = { kind: "diff", key, from, to, path, status, title, untracked, preview: !keep, rows: [], split: [], loading: true, error: null, add: 0, del: 0, repo };
    const preview = this.docs.findIndex(d => d.kind === "diff" && d.preview);
    if (preview >= 0 && !keep) { this.docs[preview] = doc; i = preview; } else { this.docs.push(doc); i = this.docs.length - 1; }
    this.active = i;
    this.loadDiff(doc, cx);
    cx.notify();
  }

  // Loads a diff doc in the current mode: only the changes, or the full file with the changes marked.
  loadDiff(doc, cx) {
    const { repo, from, to, path, untracked } = doc, full = this.fullFile;
    doc.loading = true; doc.error = null; doc.full = full;
    cx.spawn(async cx => {
      try {
        let lines;
        if (untracked) {
          const text = await readTextFile(`${repo.root}/${path}`, { on: repo.on });
          lines = text === null ? ["File not found"] : text.includes("\0") ? ["Binary file"] : textAsAdded(text);
        } else lines = await fileDiff(gitIn(repo.root, repo.on), from, to, path, full);
        if (doc.full !== full) return; // the mode changed while loading; the newer load wins
        doc.rows = unifiedRows(lines); doc.split = splitRows(doc.rows);
        doc.add = doc.rows.filter(r => r.kind === "+").length; doc.del = doc.rows.filter(r => r.kind === "-").length;
        doc.longest = Math.max(20, ...doc.rows.map(r => r.text.length));
        // Full file: start at the first change instead of line 1.
        if (full && this.docs[this.active] === doc) this.scrollToChange(doc);
      } catch (e) { if (doc.full === full) doc.error = String(e.message ?? e); }
      finally { if (doc.full === full) { doc.loading = false; cx.notify(); } }
    });
  }

  scrollToChange(doc) {
    const rows = this.split ? doc.split : doc.rows;
    const i = rows.findIndex(r => r.kind === "+" || r.kind === "-" || (r.kind === "pair" && (r.l?.kind === "-" || r.r?.kind === "+")));
    if (i > 0) this.diffScroll.scroll_to_item(Math.max(0, i - 3), "top");
  }

  setFullFile(full, cx) {
    if (this.fullFile === full) return;
    this.fullFile = full; this.persist();
    for (const d of this.docs) if (d.kind === "diff") this.loadDiff(d, cx);
  }

  // ---- branches ----
  switchBranch(b, cx) {
    if (!this.repo || this.switching) return;
    const git = this.git(), repo = this.repo;
    // A remote branch opens as a local one that tracks it (origin/foo -> foo), or the local one if it exists.
    const local = b.remote ? b.name.replace(/^[^/]+\//, "") : b.name;
    const exists = repo.list.some(x => !x.remote && x.name === local);
    const args = b.remote && !exists ? ["switch", "--track", b.name] : ["switch", local];
    this.runSwitch(git, args, `Switched to ${local}`, cx);
  }

  createBranch(cx) {
    const name = this.newBranch.value().trim();
    if (!name || !this.repo) return;
    this.runSwitch(this.git(), ["switch", "-c", name], `Created and switched to ${name}`, cx, () => this.newBranch.set_value(""));
  }

  runSwitch(git, args, ok, cx, after) {
    if (this.work.busy || this.switching) return;
    this.switching = true; this.branchNote = null; cx.notify();
    cx.spawn(async cx => {
      try {
        await git(args);
        this.branchMenu = false; this.message = ok; after?.();
        // Open files that weren't edited follow the new branch.
        for (const [i, d] of this.docs.entries()) if (d.kind === "file" && !d.dirty && d.state) this.reload(i, cx);
        this.docs = this.docs.filter(d => d.kind !== "diff");
        this.active = Math.min(this.active, this.docs.length - 1);
        this.graph.commits = []; this.graph.layout = null; this.graph.selected = null; this.graph.detail = null;
        this.cmp.files = []; this.cmp.from = null;
      } catch (e) {
        const msg = String(e.message ?? e);
        this.branchNote = /already (checked out|used by worktree)/.test(msg)
          ? "That branch is checked out in another worktree: open that worktree's space instead."
          : /would be overwritten|commit your changes or stash/.test(msg)
          ? "Your uncommitted changes conflict with that branch. Commit or discard them first (Changes view)."
          : msg.slice(0, 300);
      } finally {
        this.switching = false;
        this.loadRepo(cx); this.loadTree(cx);
        if (this.docs.some(d => d.kind === "graph")) this.loadGraph(cx);
        cx.notify();
      }
    });
  }

  branchPanel(t) {
    const q = this.branchFilter.value().toLowerCase();
    const list = (this.repo?.list ?? []).filter(b => b.name.toLowerCase().includes(q));
    const local = list.filter(b => !b.remote), remote = list.filter(b => b.remote);
    const item = b => h_flex().id(`sw-${b.name}`).h(28).flex_none().px(10).gap(8).items_center().rounded(6).cursor_pointer()
      .bg(b.name === this.repo.current ? t.selected : t.popover ?? t.raised).hover(s => s.bg(t.hover))
      .on_click((_e, cx) => { if (b.name !== this.repo.current) this.switchBranch(b, cx); cx.notify(); })
      .child(svg("mods/code/git-branch.svg").size(13).flex_none().text_color(b.remote ? t.ansi4 : t.ansi2))
      .child(div().flex_1().min_w(0).truncate().text_size(12).child(b.name))
      .when(b.name === this.repo.current, el => el.child(svg("mods/code/check.svg").size(13).text_color(t.accent)))
      .child(div().font_family(mono()).text_size(10).text_color(t.dim).child(b.sha));
    const label = s => div().px(10).pt(8).pb(3).text_size(10).font_weight(700).text_color(t.dim).child(s);
    const field = (state, id) => div().id(id).h(30).px(10).flex().items_center().rounded(7).bg(t.background).border_1().border_color(t.border)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(state).h_full().w_full().text_size(12).text_color(t.foreground));
    return v_flex().id("branch-panel").absolute().top(44).right(48).w(380).max_h(520).p(8).gap(6).rounded(10)
      .bg(t.popover ?? t.raised).border_1().border_color(t.border).shadow_lg()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(h_flex().gap(8).items_center().px(2)
        .child(div().font_weight(600).text_size(13).child("Switch branch"))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(this.switching ? "switching…" : `on ${this.repo.current}`))
        .child(this.iconBtn(t, "bp-close", "minus", "Close", () => { this.branchMenu = false; })))
      .child(field(this.branchFilter, "bp-filter"))
      .child(v_flex().id("bp-list").flex_1().min_h(0).max_h(330).overflow_y_scrollbar()
        .when(local.length > 0, el => el.child(label(`LOCAL  ${local.length}`)).children(local.map(item)))
        .when(remote.length > 0, el => el.child(label(`REMOTE  ${remote.length}`)).children(remote.slice(0, 200).map(item)))
        .when(!list.length, el => el.child(div().p(10).text_size(12).text_color(t.dim).child("No branches match"))))
      .child(div().h(1).bg(t.border))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().child(field(this.newBranch, "bp-new")))
        .child(this.btn(t, "bp-create", "Create", cx => this.createBranch(cx), { strong: true, h: 30 })))
      .when(Boolean(this.branchNote), el => el.child(div().px(4).text_size(11).text_color(t.ansi1).child(this.branchNote)));
  }

  // ---- explorer ----
  loadTree(cx) {
    this.entries = new Map(); this.treeError = null;
    if (!this.root) {
      const on = this.on;
      if (!on) this.root = home();
      else {
        cx.spawn(async cx => {
          try {
            const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on });
            if (this.on === on && !this.root && r.stdout) { this.root = r.stdout; this.loadTree(cx); this.loadRepo(cx); }
          } catch (e) { this.treeError = String(e.message ?? e); }
          finally { cx.notify(); }
        });
        return;
      }
    }
    for (const f of [...this.folders]) this.loadFolder(f, cx);
    this.loadFolder("", cx);
  }

  loadFolder(rel, cx) {
    if (!this.root) return;
    const root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const list = await directory(rel ? `${root}/${rel}` : root, on);
        if (root !== this.root || on !== this.on) return;
        this.entries.set(rel, list.slice(0, PER_FOLDER).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
      } catch (e) { if (!rel) this.treeError = String(e.message ?? e); else this.folders.delete(rel); }
      finally { cx.notify(); }
    });
  }

  toggle(rel, cx) {
    if (this.folders.has(rel)) {
      for (const f of [...this.folders]) if (f === rel || f.startsWith(rel + "/")) { this.folders.delete(f); this.entries.delete(f); }
    } else { this.folders.add(rel); this.loadFolder(rel, cx); }
    this.persist(); cx.notify();
  }

  // The folder a new entry goes in: the selected folder, else the selected file's folder, else the root.
  targetDir() {
    const s = this.treeSel;
    if (!s) return "";
    return s.dir ? s.rel : s.rel.includes("/") ? s.rel.slice(0, s.rel.lastIndexOf("/")) : "";
  }

  startCreate(kind, cx) {
    if (!this.root) return;
    const dir = this.targetDir();
    this.view = "explorer"; this.sidebar = true;
    this.creating = { kind, dir, busy: false, error: null };
    if (dir && !this.folders.has(dir)) { this.folders.add(dir); this.loadFolder(dir, cx); this.persist(); }
    this.newName.set_value(""); this.newName.focus(); cx.notify();
    cx.timer.after(50, () => { if (this.creating) this.newName.focus(); });   // the field exists only from the next frame
  }

  cancelCreate(cx) {
    if (!this.creating || this.creating.busy) return;
    this.creating = null; cx.notify();
  }

  finishCreate(cx) {
    const c = this.creating;
    if (!c || c.busy) return;
    const name = this.newName.value().trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!name) { this.cancelCreate(cx); return; }
    if (name.split("/").some(p => !p || p === "." || p === "..") || /[\0:*?"<>|]/.test(name)) {
      c.error = "Not a valid name"; cx.notify(); return;
    }
    const rel = c.dir ? `${c.dir}/${name}` : name, abs = `${this.root}/${rel}`, on = this.on, root = this.root;
    c.busy = true; c.error = null; cx.notify();
    cx.spawn(async cx => {
      try {
        await createEntry(abs, c.kind === "folder", on);
        if (root !== this.root || on !== this.on) return;
        this.creating = null;
        const parts = rel.split("/"), dirs = new Set([c.dir]);
        for (let i = 1; i < parts.length + (c.kind === "folder" ? 1 : 0); i++) {
          const f = parts.slice(0, i).join("/");
          this.folders.add(f); dirs.add(f);
        }
        for (const d of dirs) this.loadFolder(d, cx);
        this.treeSel = { rel, dir: c.kind === "folder" };
        this.message = `Created ${name}`; this.persist();
        if (c.kind === "file") this.open(abs, on, cx, true);
        this.loadWork(cx);
      } catch (e) {
        c.busy = false; c.error = String(e.message ?? e).slice(0, 160); this.newName.focus();
      } finally { cx.notify(); }
    });
  }

  newRow(depth, t) {
    const c = this.creating, folder = c.kind === "folder";
    const row = h_flex().id("tree-new").h(26).flex_none().pl(6 + depth * 14).pr(6).gap(4).items_center()
      .child(div().w(11).flex_none())
      .child(div().w(26).flex_none().flex().justify_center()
        .child(svg(`mods/code/${folder ? "folder" : "file"}.svg`).size(14).text_color(folder ? t.accent : t.dim)))
      .child(div().id("tree-new-box").flex_1().min_w(0).h(22).px(6).flex().items_center().rounded(4).bg(t.background)
        .border_1().border_color(c.error ? t.ansi1 : t.accent)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); this.cancelCreate(cx); } })
        .child(Input.new(this.newName).h_full().w_full().text_size(12).text_color(t.foreground)));
    if (!c.error) return [row];
    return [row, div().id("tree-new-err").flex_none().ml(6 + depth * 14 + 41).mr(6).mb(2).px(6).py(2).rounded(4)
      .text_size(11).bg(t.raised).text_color(t.ansi1).child(c.error)];
  }

  setRoot(root, on, cx) {
    if (root === this.root && on === this.on) return;
    this.creating = null; this.treeSel = null;
    this.root = root; this.on = on; this.repo = null; this.work.note = null;
    this.folders = new Set(); this.loadTree(cx); this.loadRepo(cx); this.persist();
  }

  refreshAll(cx) {
    const sp = spaces().find(x => x.id === this.space);
    const root = this.spaceFolder(), on = sp?.machine ?? null;
    if (root !== this.root || on !== this.on) this.setRoot(root, on, cx);
    else { this.loadTree(cx); this.loadRepo(cx); }
    if (this.view === "graph" || this.docs.some(d => d.kind === "graph")) this.loadGraph(cx);
  }

  // ---- documents ----
  open(path, on, cx, focus) {
    const found = this.docs.findIndex(d => d.kind === "file" && d.path === path && d.on === on);
    if (found >= 0) { this.active = found; if (focus) this.docs[found].state?.focus(); this.persist(); cx.notify(); return; }
    const doc = { kind: "file", path, on, state: null, disk: null, base: null, dirty: false, error: null, conflict: false, saving: false, confirmClose: false, crlf: false };
    this.docs.push(doc); this.active = this.docs.length - 1; this.persist();
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(path, { on });
        if (!this.docs.includes(doc)) return;
        if (text === null) { doc.error = "This file doesn't exist (any more)."; return; }
        if (text.includes("\0")) { doc.error = "Binary file: can't be edited here."; return; }
        this.load(doc, text);
        if (focus) doc.state.focus();
      } catch (e) { doc.error = "Can't open this file (too large over 1 MiB, or unreadable)."; }
      finally { cx.notify(); }
    });
    cx.notify();
  }

  load(doc, text) {
    const t = theme(), s = settings(), e = ext(doc.path);
    doc.state?.release();
    const tabs = /^\t/m.test(text) && !/^ {2,}\S/m.test(text);
    const four = /^ {4}\S/m.test(text) && !/^ {2}\S/m.test(text);
    doc.state = EditorState.new({ language: languageOf(doc.path)[0], value: text, font_family: s.font_family, font_size: s.font_size,
      tab_size: four || tabs ? 4 : 2, hard_tabs: tabs,
      syntax: { keyword: t.ansi5, string: t.ansi2, "string.escape": t.ansi6, comment: t.dim, function: t.ansi4, type: t.ansi3,
        number: t.ansi1, constant: t.ansi6, boolean: t.ansi1, operator: t.ansi6, punctuation: t.muted, variable: t.foreground,
        heading: t.ansi4, strong: t.ansi3, emphasis: t.ansi5, code: t.ansi2, quote: t.dim, list: t.ansi5, link: t.ansi6 } });
    doc.disk = text; doc.crlf = text.includes("\r\n");
    doc.base = doc.state.value(); doc.dirty = false; doc.conflict = false; doc.error = null;
    doc.state.on("change", (_e, cx) => {
      const dirty = doc.state.value() !== doc.base;
      if (dirty !== doc.dirty) { doc.dirty = dirty; cx.notify(); }
    });
  }

  save(i, cx, force) {
    const doc = this.docs[i];
    if (doc?.kind !== "file" || !doc.state || doc.saving) return;
    let text = doc.state.value();
    if (doc.crlf && !text.includes("\r")) text = text.replace(/\n/g, "\r\n");
    doc.saving = true; doc.conflict = false; this.message = null; cx.notify();
    cx.spawn(async cx => {
      try {
        if (!force) {
          const now = await readTextFile(doc.path, { on: doc.on });
          if (now !== doc.disk) { doc.conflict = true; return; }
        }
        if (doc.on) await saveRemote(doc.path, text, doc.on);
        else await writeTextFile(doc.path, text, force ? await readTextFile(doc.path) : doc.disk);
        doc.disk = text; doc.base = doc.state.value(); doc.dirty = false; doc.confirmClose = false;
        this.message = `Saved ${base(doc.path)}`;
        if (doc.closeAfter) this.drop(doc);
        this.loadWork(cx);
      } catch (e) {
        if (!doc.on && /stale|changed|match/i.test(String(e))) doc.conflict = true;
        else this.message = `Couldn't save: ${String(e.message ?? e).slice(0, 200)}`;
      } finally { doc.saving = false; doc.closeAfter = false; cx.notify(); }
    });
  }

  reload(i, cx, onlyIfClean = false) {
    const doc = this.docs[i], state = doc.state;
    if (onlyIfClean && (!state || doc.dirty || doc.saving)) return;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(doc.path, { on: doc.on });
        if (onlyIfClean && (!this.docs.includes(doc) || doc.state !== state || doc.dirty || doc.saving || text === doc.disk)) return;
        if (text === null) doc.error = "This file doesn't exist (any more).";
        else this.load(doc, text);
      } catch { if (!onlyIfClean) doc.error = "Can't reload this file."; }
      finally { cx.notify(); }
    });
  }

  close(i, cx) {
    const doc = this.docs[i];
    if (!doc) return;
    if (doc.dirty) { this.active = i; doc.confirmClose = true; cx.notify(); return; }
    this.drop(doc); cx.notify();
  }

  drop(doc) {
    const i = this.docs.indexOf(doc);
    if (i < 0) return;
    doc.state?.release();
    this.docs.splice(i, 1);
    if (this.active >= this.docs.length || this.active > i) this.active = Math.max(this.docs.length ? 0 : -1, this.active - 1);
    this.persist();
  }

  takeRequest(cx) {
    const req = shared("code.open");
    if (!req || req.space !== this.space || req.n <= this.seen) return;
    this.seen = req.n;
    if (req.root) this.setRoot(req.root, req.on ?? null, cx);
    if (req.path) { this.view = "explorer"; this.open(req.path, req.on ?? null, cx, true); }
  }

  dedupe() {
    if (!this.dedupeUntil) return false;
    if (Date.now() > this.dedupeUntil) { this.dedupeUntil = 0; return false; }
    const space = spaces().find(s => s.active), mine = focused()?.tab;
    if (!space || !mine) return false;
    const tab = space.tabs.find(t => t.id === mine);
    if (!tab || tab.panes !== 1 || !panes().some(p => p.tab === mine && p.mod === "code")) return false;
    const tabs = new Set(space.tabs.map(t => t.id));
    const other = panes().find(p => p.mod === "code" && tabs.has(p.tab) && p.tab !== mine);
    if (!other) return false;
    this.dedupeUntil = 0;
    run("tab.select", { id: other.tab });
    run("tab.close", { id: mine, confirmed: true });
    return true;
  }

  // ======== UI pieces ========
  badge(name, size = 9) {
    const [label, color] = fileIcon(name);
    return div().w(26).flex_none().flex().justify_center().text_size(size).font_weight(700).text_color(color).child(label);
  }

  btn(t, id, label, onClick, opts = {}) {
    const on = opts.active, strong = opts.strong;
    return h_flex().id(id).h(opts.h ?? 26).px(opts.px ?? 10).gap(6).items_center().flex_none().rounded(6).cursor_pointer().text_size(12)
      .bg(strong ? t.solid : on ? t.selected : opts.bg ?? t.raised).text_color(strong ? t.solid_foreground : on ? t.foreground : t.muted)
      .hover(s => s.bg(strong ? t.accent : t.hover).text_color(strong ? t.solid_foreground : t.foreground))
      .on_click((e, cx) => { onClick(cx, e); cx.notify(); })
      .when(Boolean(opts.icon), el => el.child(svg(`mods/code/${opts.icon}.svg`).size(14).flex_none()))
      .when(label !== null, el => el.child(label));
  }

  section(t, title, right) {
    return h_flex().h(32).flex_none().px(12).gap(6).items_center()
      .child(div().text_size(11).font_weight(600).text_color(t.muted).child(title))
      .child(div().flex_1()).children(right ?? []);
  }

  statusColor(t, s) { return s === "A" ? t.ansi2 : s === "D" || s === "U" ? t.ansi1 : t.ansi3; }

  iconBtn(t, id, icon, tip, onClick, color) {
    return div().id(id).w(22).h(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
      .text_color(color ?? t.muted).hover(s => s.bg(t.raised).text_color(t.foreground)).tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); cx.notify(); })
      .child(svg(`mods/code/${icon}.svg`).size(14));
  }

  // Changed files as a tree (folders folded "a/b/c") or a flat list; click opens the diff.
  // opts: { actions(f) -> buttons shown on hover, menu(f) -> [{label, run, danger}] for the ⋯ menu, flat }
  changeTree(t, prefix, files, makeDiff, opts = {}) {
    const rows = [], active = this.docs[this.active];
    const fileRow = (f, depth, dir) => {
      const spec = makeDiff(f), key = `${spec.from}|${spec.to}|${f.path}`, id = `${prefix}-f-${f.path}`;
      const selected = active?.kind === "diff" && active.key === key, hovered = this.hover === id;
      const menuOpen = this.rowMenu?.id === id, tools = hovered || menuOpen;
      rows.push(h_flex().id(id).h(24).flex_none().pl(8 + depth * 14).pr(6).gap(4).items_center().rounded(5).cursor_pointer()
        .bg(selected || menuOpen ? t.selected : t.chrome).hover(s => s.bg(selected ? t.selected : t.hover))
        .on_hover((on, cx) => { if (on) this.hover = id; else if (this.hover === id) this.hover = null; cx.notify(); })
        .on_click((e, cx) => this.openDiff(spec, cx, e.click_count >= 2))
        .when(!opts.flat, el => el.child(div().w(11).flex_none()))
        .child(this.badge(f.name))
        .child(h_flex().flex_1().min_w(0).gap(6).items_center()
          .child(div().flex_shrink(0).max_w(220).truncate().text_color(f.status === "D" ? t.dim : t.foreground).child(f.name))
          .when(Boolean(dir), el => el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(dir))))
        .when(tools && Boolean(opts.actions), el => el.children(opts.actions(f)))
        .when(tools && Boolean(opts.menu), el => el.child(this.iconBtn(t, `${id}-more`, "more", "More actions", () => { this.rowMenu = menuOpen ? null : { id }; })))
        .when(!tools && f.add > 0, el => el.child(div().text_size(10).text_color(t.ansi2).child(`+${f.add}`)))
        .when(!tools && f.del > 0, el => el.child(div().text_size(10).text_color(t.ansi1).child(`−${f.del}`)))
        .child(div().w(14).flex_none().text_right().text_size(11).font_weight(700).text_color(this.statusColor(t, f.status)).child(f.untracked ? "U" : f.status)));
      if (menuOpen && opts.menu) rows.push(v_flex().mx(8).my(2).p(4).flex_none().rounded(7).bg(t.popover ?? t.raised).border_1().border_color(t.border)
        .children(opts.menu(f).map((m, n) => h_flex().id(`${id}-m${n}`).h(26).px(8).items_center().rounded(5).cursor_pointer().text_size(12)
          .text_color(m.danger ? t.ansi1 : t.foreground).hover(s => s.bg(t.hover))
          .on_click((_e, cx) => { this.rowMenu = null; m.run(cx); cx.notify(); }).child(m.label))));
    };
    if (opts.flat) {
      for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
        const name = f.path.split("/").pop(), dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
        fileRow({ ...f, name }, 0, dir);
      }
      return rows;
    }
    const walk = (node, depth) => {
      const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
      for (const d of dirs) {
        const key = `${prefix}:${d.path}`, closed = this.collapsed.has(key);
        rows.push(h_flex().id(`${prefix}-d-${d.path}`).h(24).flex_none().pl(8 + depth * 14).pr(8).gap(5).items_center().rounded(5).cursor_pointer()
          .hover(s => s.bg(t.hover))
          .on_click((_e, cx) => { closed ? this.collapsed.delete(key) : this.collapsed.add(key); cx.notify(); })
          .child(svg(`mods/code/chevron-${closed ? "right" : "down"}.svg`).size(11).flex_none().text_color(t.dim))
          .child(svg("mods/code/folder.svg").size(13).flex_none().text_color(t.accent))
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(d.name)));
        if (!closed) walk(d, depth + 1);
      }
      for (const f of [...node.files].sort((a, b) => a.name.localeCompare(b.name))) fileRow(f, depth, null);
    };
    walk(buildTree(files), 0);
    return rows;
  }

  sumStats(files) { return files.reduce((a, f) => ({ add: a.add + (f.add || 0), del: a.del + (f.del || 0) }), { add: 0, del: 0 }); }

  // ---- sidebars ----
  explorerRows(prefix, depth, out, t) {
    if (depth > 30) return out;
    const current = this.docs[this.active];
    if (this.creating?.dir === prefix) out.push(...this.newRow(depth, t));
    for (const entry of this.entries.get(prefix) ?? []) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(rel);
      const abs = `${this.root}/${rel}`;
      const selected = entry.dir ? this.treeSel?.dir === true && this.treeSel.rel === rel
        : current?.kind === "file" && current.path === abs && current.on === this.on;
      out.push(h_flex().id(`tree-${rel}`).h(24).flex_none().pl(6 + depth * 14).pr(6).gap(4).items_center().rounded(5).cursor_pointer()
        .bg(selected ? t.selected : t.chrome).hover(s => s.bg(selected ? t.selected : t.hover))
        .on_click((_e, cx) => { this.treeSel = { rel, dir: entry.dir }; entry.dir ? this.toggle(rel, cx) : this.open(abs, this.on, cx, true); })
        .child(entry.dir ? svg(`mods/code/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim) : div().w(11).flex_none())
        .child(entry.dir ? div().w(26).flex_none().flex().justify_center().child(svg("mods/code/folder.svg").size(14).text_color(t.accent)) : this.badge(entry.name))
        .child(div().flex_1().min_w(0).truncate().text_color(selected ? t.foreground : t.muted).child(entry.name)));
      if (entry.dir && open) this.explorerRows(rel, depth + 1, out, t);
    }
    return out;
  }

  sideExplorer(t) {
    return v_flex().flex_1().min_h(0)
      .child(this.section(t, `EXPLORER · ${this.root ? base(this.root) || this.root : ""}`, this.root ? [
        this.iconBtn(t, "new-file", "file-plus", "New file…", cx => this.startCreate("file", cx)),
        this.iconBtn(t, "new-folder", "folder-plus", "New folder…", cx => this.startCreate("folder", cx)),
        this.iconBtn(t, "tree-refresh", "refresh", "Refresh", cx => this.loadTree(cx))] : []))
      .child(v_flex().id("tree").flex_1().min_h(0).overflow_y_scrollbar().px(4).pb(6).text_size(13).children(this.explorerRows("", 0, [], t))
        .when(Boolean(this.treeError) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim)
          .child(this.treeError || (this.root ? "Loading…" : "No folder")))));
  }

  workDiff(f, staged) {
    if (staged) return { from: "--cached", to: null, path: f.path, status: f.status };
    return { from: "", to: null, path: f.path, status: f.status, untracked: f.untracked || (!this.work.hasHead && f.status === "A") };
  }

  sideChanges(t) {
    const w = this.work, all = [...w.staged, ...w.unstaged], s = this.sumStats(all);
    const busy = w.busy, n = new Set(all.map(f => f.path)).size;
    const stagedOnly = w.staged.length > 0, canCommit = Boolean(this.repo) && !busy && n > 0;
    const flat = !this.changesTree;
    const openFile = f => cx => this.open(`${this.repo.root}/${f.path}`, this.repo.on, cx, true);
    const ignoreItems = f => {
      const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : null;
      const ext = f.path.includes(".") ? f.path.split(".").pop() : null;
      return [
        { label: "Add to .gitignore", run: cx => this.ignore(`/${f.path}`, cx) },
        ...(dir ? [{ label: `Add folder ${dir}/ to .gitignore`, run: cx => this.ignore(`/${dir}/`, cx) }] : []),
        ...(ext && ext.length < 8 && !ext.includes("/") ? [{ label: `Ignore all *.${ext} files`, run: cx => this.ignore(`*.${ext}`, cx) }] : []),
        { label: "Copy path", run: cx => { cx.write_to_clipboard(f.path); this.work.note = `Copied ${f.path}`; } },
        { label: "Copy full path", run: cx => { cx.write_to_clipboard(`${this.repo.root}/${f.path}`); this.work.note = "Copied full path"; } },
      ];
    };
    const sectionHeader = (id, title, count, buttons) => h_flex().id(id).h(28).flex_none().px(8).gap(4).items_center().rounded(5).cursor_pointer()
      .hover(s => s.bg(t.hover))
      .on_hover((on, cx) => { if (on) this.hover = id; else if (this.hover === id) this.hover = null; cx.notify(); })
      .on_click((_e, cx) => { this.collapsed.has(id) ? this.collapsed.delete(id) : this.collapsed.add(id); cx.notify(); })
      .child(svg(`mods/code/chevron-${this.collapsed.has(id) ? "right" : "down"}.svg`).size(11).text_color(t.dim))
      .child(div().text_size(11).font_weight(700).text_color(t.muted).child(title))
      .child(div().flex_1())
      .when(this.hover === id, el => el.children(buttons))
      .child(div().h(16).min_w(16).px(5).rounded(8).bg(t.raised).text_size(10).text_color(t.muted).flex().items_center().justify_center().child(String(count)));
    const unstageOne = f => cx => this.gitAction("Unstage", git => unstage(git, [f.path], w.hasHead), cx);
    const stageOne = f => cx => this.gitAction("Stage", git => stage(git, [f.path]), cx);
    const stagedRows = this.repo ? this.changeTree(t, "s", w.staged, f => this.workDiff(f, true), {
      flat,
      actions: f => [
        ...(f.status !== "D" ? [this.iconBtn(t, `s-open-${f.path}`, "file", "Open file", openFile(f))] : []),
        this.iconBtn(t, `s-unstage-${f.path}`, "minus", "Unstage", unstageOne(f)),
      ],
      menu: f => [
        ...(f.status !== "D" ? [{ label: "Open file", run: openFile(f) }] : []),
        { label: "Unstage", run: unstageOne(f) },
        ...ignoreItems(f),
      ],
    }) : [];
    const workRows = this.repo ? this.changeTree(t, "u", w.unstaged, f => this.workDiff(f, false), {
      flat,
      actions: f => [
        ...(f.status !== "D" ? [this.iconBtn(t, `u-open-${f.path}`, "file", "Open file", openFile(f))] : []),
        this.iconBtn(t, `u-discard-${f.path}`, "discard", f.untracked ? "Delete file" : "Discard changes", cx => this.askDiscard([f], cx)),
        this.iconBtn(t, `u-stage-${f.path}`, "plus", "Stage", stageOne(f)),
      ],
      menu: f => [
        ...(f.status !== "D" ? [{ label: "Open file", run: openFile(f) }] : []),
        { label: "Stage", run: stageOne(f) },
        { label: f.untracked ? "Delete file…" : "Discard changes…", danger: true, run: cx => this.askDiscard([f], cx) },
        ...ignoreItems(f),
      ],
    }) : [];
    const c = this.confirm;
    return v_flex().flex_1().min_h(0)
      .child(this.section(t, "SOURCE CONTROL", [
        div().text_size(11).text_color(t.ansi2).child(`+${s.add}`), div().text_size(11).text_color(t.ansi1).child(`−${s.del}`),
        this.iconBtn(t, "view-mode", flat ? "tree" : "list", flat ? "View as tree" : "View as list", () => { this.changesTree = !this.changesTree; this.persist(); }),
        this.iconBtn(t, "work-refresh", "refresh", "Refresh", cx => this.loadWork(cx))]))
      .when(Boolean(this.repo), el => el.child(v_flex().flex_none().px(10).pb(8).gap(6)
        .child(div().h(32).px(10).flex().items_center().rounded(7).bg(t.background).border_1().border_color(t.border)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.commitMsg).h_full().w_full().text_size(12).text_color(t.foreground)))
        .child(this.btn(t, "commit", busy === "commit" ? "Committing…" : stagedOnly ? `✓ Commit ${w.staged.length} staged` : n ? `✓ Commit all ${n}` : "✓ Commit",
          cx => this.commitAll(cx), { strong: canCommit, h: 30 }).justify_center())
        .child(this.btn(t, "pull", busy === "pull" ? "Pulling…" : "↓ Pull",
          cx => this.pullBranch(cx), { h: 28 }).justify_center().tooltip("Pull from upstream (fast-forward only)"))
        .when(Boolean(w.note), el => el.child(div().text_size(11).text_color(/failed/.test(w.note ?? "") ? t.ansi1 : t.ansi2).child(w.note)))))
      .when(Boolean(c), el => el.child(v_flex().mx(10).mb(8).p(10).gap(6).flex_none().rounded(8).bg(t.ansi1 + "18").border_1().border_color(t.ansi1 + "66")
        .child(div().text_size(12).font_weight(600).child(c.title))
        .child(div().text_size(11).text_color(t.muted).child(c.detail))
        .child(h_flex().gap(6).justify_end()
          .child(this.btn(t, "cf-cancel", "Cancel", () => { this.confirm = null; }, { h: 24 }))
          .child(h_flex().id("cf-ok").h(24).px(10).items_center().rounded(6).cursor_pointer().text_size(12).bg(t.ansi1).text_color(t.background)
            .on_click((_e, cx) => c.run(cx)).child(c.label)))))
      .child(v_flex().id("work-tree").flex_1().min_h(0).overflow_y_scrollbar().px(4).pb(6).text_size(13)
        .when(w.staged.length > 0, el => el.child(sectionHeader("sec-staged", "STAGED CHANGES", w.staged.length, [
          this.iconBtn(t, "unstage-all", "minus", "Unstage all", cx => this.gitAction("Unstage", git => unstage(git, w.staged.map(f => f.path), w.hasHead), cx))]))
          .when(!this.collapsed.has("sec-staged"), el => el.children(stagedRows)))
        .when(w.unstaged.length > 0, el => el.child(sectionHeader("sec-work", "CHANGES", w.unstaged.length, [
          this.iconBtn(t, "discard-all", "discard", "Discard all changes", cx => this.askDiscard(w.unstaged, cx)),
          this.iconBtn(t, "stage-all", "plus", "Stage all", cx => this.gitAction("Stage", git => stage(git, w.unstaged.map(f => f.path)), cx))]))
          .when(!this.collapsed.has("sec-work"), el => el.children(workRows)))
        .when(!n, el => el.child(div().p(10).text_size(12).text_color(t.dim)
          .child(!this.repo ? "Not a git repository" : w.error || (w.loading && !w.at ? "Loading…" : "No uncommitted changes ✓")))));
  }

  refPicker(t, which) {
    const q = this.pickerFilter.value().toLowerCase(), list = (this.repo?.list ?? []).filter(b => b.name.toLowerCase().includes(q));
    const cur = this.cmp[which];
    return v_flex().mx(10).mb(8).rounded(8).border_1().border_color(t.border).bg(t.background).overflow_hidden()
      .child(div().h(30).px(8).flex().items_center().border_b(1).border_color(t.border)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(this.pickerFilter).h_full().w_full().text_size(12).text_color(t.foreground)))
      .child(v_flex().id(`pick-${which}`).max_h(260).overflow_y_scrollbar().p(4).children(list.slice(0, 300).map(b =>
        h_flex().id(`pk-${which}-${b.name}`).h(26).flex_none().px(8).gap(6).items_center().rounded(5).cursor_pointer()
          .bg(b.name === cur ? t.selected : t.background).hover(s => s.bg(t.hover))
          .on_click((_e, cx) => { this.cmp[which] = b.name; this.picker = null; this.loadCompare(cx); cx.notify(); })
          .child(svg("mods/code/git-branch.svg").size(12).flex_none().text_color(b.remote ? t.ansi4 : t.ansi2))
          .child(div().flex_1().min_w(0).truncate().text_size(12).child(b.name))
          .when(b.name === this.repo.current, el => el.child(div().text_size(10).text_color(t.accent).child("current")))))
        .when(!list.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child("No branches match"))));
  }

  refButton(t, which, label) {
    const value = this.cmp[which] ?? "—", open = this.picker === which;
    return v_flex().gap(3).px(10)
      .child(div().text_size(10).font_weight(600).text_color(t.dim).child(label))
      .child(h_flex().id(`ref-${which}`).h(30).px(10).gap(6).items_center().rounded(7).cursor_pointer()
        .bg(t.background).border_1().border_color(open ? t.accent : t.border).hover(s => s.border_color(t.accent))
        .on_click((_e, cx) => { this.picker = open ? null : which; this.pickerFilter.set_value(""); cx.notify(); })
        .child(svg("mods/code/git-branch.svg").size(13).flex_none().text_color(which === "base" ? t.ansi4 : t.ansi2))
        .child(div().flex_1().min_w(0).truncate().text_size(12).child(value + (value === this.repo?.current ? "  (current)" : "")))
        .child(svg(`mods/code/chevron-${open ? "down" : "right"}.svg`).size(11).text_color(t.dim)));
  }

  sideCompare(t) {
    const c = this.cmp, s = this.sumStats(c.files), live = c.live && c.head === this.repo?.current;
    if (!this.repo) return v_flex().flex_1().child(this.section(t, "COMPARE")).child(div().p(12).text_size(12).text_color(t.dim).child("Not a git repository"));
    return v_flex().flex_1().min_h(0)
      .child(this.section(t, "COMPARE BRANCHES", [
        this.btn(t, "cmp-swap", null, cx => { [c.base, c.head] = [c.head, c.base]; this.loadCompare(cx); }, { icon: "swap", h: 22, px: 6, bg: t.chrome }),
        this.btn(t, "cmp-reset", null, cx => { c.base = this.repo.base; c.head = this.repo.current; this.loadCompare(cx); }, { icon: "refresh", h: 22, px: 6, bg: t.chrome })]))
      .child(v_flex().flex_none().gap(8).pb(8)
        .child(this.refButton(t, "base", "BASE")).when(this.picker === "base", el => el.child(this.refPicker(t, "base")))
        .child(this.refButton(t, "head", "COMPARE")).when(this.picker === "head", el => el.child(this.refPicker(t, "head")))
        .when(c.head === this.repo.current, el => el.child(h_flex().id("cmp-live").px(10).gap(8).items_center().cursor_pointer()
          .on_click((_e, cx) => { c.live = !c.live; this.loadCompare(cx); cx.notify(); })
          .child(div().w(14).h(14).rounded(4).border_1().border_color(c.live ? t.accent : t.input).bg(c.live ? t.accent : t.background)
            .flex().items_center().justify_center().text_size(10).text_color(t.accent_foreground).child(c.live ? "✓" : ""))
          .child(div().text_size(12).text_color(t.muted).child("Include uncommitted changes"))))
        .child(h_flex().mx(10).px(10).py(7).gap(10).rounded(7).bg(t.raised).text_size(11).flex_wrap()
          .child(div().text_color(t.foreground).child(`${c.files.length} files`))
          .child(div().text_color(t.ansi2).child(`+${s.add}`)).child(div().text_color(t.ansi1).child(`−${s.del}`))
          .when(Boolean(c.info), el => el.child(div().text_color(t.muted).child(`↑${c.info.ahead} ↓${c.info.behind}`)))
          .when(c.loading, el => el.child(div().text_color(t.dim).child("loading…")))))
      .child(v_flex().id("cmp-tree").flex_1().min_h(0).overflow_y_scrollbar().px(4).pb(6).text_size(13)
        .children(c.from ? this.changeTree(t, "c", c.files, f => ({ from: c.from, to: c.to, path: f.path, status: f.status })) : [])
        .when(!c.files.length && !c.loading, el => el.child(div().p(10).text_size(12).text_color(c.error ? t.ansi1 : t.dim)
          .child(c.error || (live ? "No differences (including uncommitted changes)" : "No differences")))));
  }

  sideGraph(t) {
    if (!this.repo) return v_flex().flex_1().child(this.section(t, "BRANCHES")).child(div().p(12).text_size(12).text_color(t.dim).child("Not a git repository"));
    const row = b => h_flex().id(`br-${b.name}`).h(24).flex_none().px(10).gap(6).items_center().rounded(5).cursor_pointer().hover(s => s.bg(t.hover))
      .on_click((_e, cx) => this.jumpTo(b.name, cx))
      .child(svg("mods/code/git-branch.svg").size(12).flex_none().text_color(b.remote ? t.ansi4 : t.ansi2))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(b.name === this.repo.current ? t.foreground : t.muted).child(b.name))
      .when(b.name === this.repo.current, el => el.child(div().w(6).h(6).rounded(3).bg(t.accent)));
    const local = this.repo.list.filter(b => !b.remote), remote = this.repo.list.filter(b => b.remote);
    return v_flex().flex_1().min_h(0)
      .child(this.section(t, "BRANCHES · click to find in history", [
        this.btn(t, "g-all", this.graph.all ? "All branches" : "Current branch", cx => { this.graph.all = !this.graph.all; this.loadGraph(cx); }, { h: 22, px: 8, bg: t.chrome })]))
      .child(v_flex().id("branches").flex_1().min_h(0).overflow_y_scrollbar().px(4).pb(6)
        .child(div().px(10).pt(4).pb(2).text_size(10).font_weight(600).text_color(t.dim).child(`LOCAL  ${local.length}`))
        .children(local.map(row))
        .child(div().px(10).pt(10).pb(2).text_size(10).font_weight(600).text_color(t.dim).child(`REMOTE  ${remote.length}`))
        .children(remote.slice(0, 300).map(row)));
  }

  // ---- diff find / line selection ----
  diffRowsOf(doc) { return this.split ? doc.split : doc.rows; }

  findHits(rows) {
    const q = this.find.open ? this.find.query.toLowerCase() : "";
    if (!q || !rows) return [];
    if (this.find.rows !== rows || this.find.q !== q) {
      const hit = s => Boolean(s?.toLowerCase().includes(q));
      this.find.hits = rows.flatMap((r, i) => hit(r.text) || hit(r.l?.text) || hit(r.r?.text) ? [i] : []);
      this.find.rows = rows; this.find.q = q;
    }
    return this.find.hits;
  }

  jumpHit(step) {
    const doc = this.docs[this.active];
    if (doc?.kind !== "diff") return;
    const hits = this.findHits(this.diffRowsOf(doc));
    if (!hits.length) return;
    this.find.at = (this.find.at + step + hits.length) % hits.length;
    this.diffScroll.scroll_to_item(hits[this.find.at], "center");
  }

  mark(text, t, current) {
    const q = this.find.open ? this.find.query.toLowerCase() : "";
    if (!q || !text) return text;
    const low = text.toLowerCase(), parts = [];
    let i = 0, j;
    while ((j = low.indexOf(q, i)) >= 0) {
      if (j > i) parts.push(div().child(text.slice(i, j)));
      parts.push(div().rounded(2).bg(current ? t.ansi3 : t.ansi3 + "55").when(current, e => e.text_color(t.background)).child(text.slice(j, j + q.length)));
      i = j + q.length;
    }
    if (!parts.length) return text;
    if (i < text.length) parts.push(div().child(text.slice(i)));
    return h_flex().children(parts);
  }

  // side: "l"/"r" for a split cell, null for a whole row (which joins a selection on either side).
  selectable(el, id, i, side, t) {
    const s = this.sel?.id === id ? this.sel : null;
    const on = s && (side === null || s.side === side) && i >= Math.min(s.a, s.b) && i <= Math.max(s.a, s.b);
    return el.when(Boolean(on), e => e.bg(t.selection + "99"));
  }

  // Virtual list rows can't take mouse handlers, so the diff body maps the pointer to a row itself.
  pointRow(e, count, rowH) {
    if (!e.local_position) return null;
    const zoom = settings().zoom || 1, y = e.local_position.y / zoom + this.diffScroll.offset().y;
    const i = Math.floor(y / rowH);
    if (i < 0 || i >= count) return null;
    const side = this.split ? (e.bounds && e.local_position.x < e.bounds.width / 2 ? "l" : "r") : null;
    return { i, side };
  }

  diffMouseDown(e, cx, id, count, rowH) {
    const p = this.pointRow(e, count, rowH);
    if (!p) return;
    const s = this.sel?.id === id ? this.sel : null;
    this.sel = e.modifiers.shift && s ? { ...s, b: p.i, drag: true } : { id, a: p.i, b: p.i, side: p.side, drag: true };
    cx.notify();
  }

  diffMouseMove(e, cx, id, count, rowH) {
    const cur = this.sel;
    if (!cur?.drag || cur.id !== id || e.pressed_button !== "left") return;
    const p = this.pointRow(e, count, rowH);
    if (p && cur.b !== p.i) { cur.b = p.i; cx.notify(); }
  }

  copyDiff(cx) {
    const doc = this.docs[this.active], s = this.sel;
    if (!s || s.id !== `${doc.key}-${this.split}`) return;
    const lines = this.diffRowsOf(doc).slice(Math.min(s.a, s.b), Math.max(s.a, s.b) + 1)
      .map(r => r.kind === "pair" ? (s.side === "l" ? r.l : r.r)?.text : r.text).filter(x => x != null);
    cx.write_to_clipboard(lines.join("\n"));
    this.message = `Copied ${lines.length} line${lines.length === 1 ? "" : "s"}`;
  }

  diffKey(e, cx) {
    const doc = this.docs[this.active];
    if (doc?.kind !== "diff") return;
    const m = e.modifiers, mod = (m.control || m.platform) && !m.alt && !m.shift, k = e.key.toLowerCase();
    const done = () => { cx.stop_propagation(); cx.notify(); };
    if (mod && k === "f") { this.find.open = true; this.find.rows = null; this.findInput.focus(); return done(); }
    if (k === "f3") { this.jumpHit(m.shift ? -1 : 1); return done(); }
    if (k === "escape" && this.find.open) { this.find.open = false; this.handle.focus(); return done(); }
    if (this.find.focused) return;
    if (mod && k === "c" && this.sel) { this.copyDiff(cx); return done(); }
    if (mod && k === "a") { const n = this.diffRowsOf(doc).length; this.sel = { id: `${doc.key}-${this.split}`, a: 0, b: n - 1, side: this.split ? "r" : null }; return done(); }
    if (k === "escape" && this.sel) { this.sel = null; return done(); }
  }

  findBar(t, hits) {
    return h_flex().id("find-bar").absolute().top(6).right(18).h(32).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).pl(10).pr(4).gap(4).items_center().rounded(8).bg(t.popover).border_1().border_color(this.find.focused ? t.accent : t.border).text_size(12)
      .child(div().id("find-input").w(200).h_full().flex().items_center().cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.findInput).h_full().text_size(12).text_color(t.foreground)))
      .child(div().w(58).text_right().text_size(11).text_color(this.find.query && !hits.length ? t.ansi1 : t.dim).child(this.find.query ? (hits.length ? `${this.find.at + 1}/${hits.length}` : "0 results") : ""))
      .child(this.btn(t, "find-prev", "↑", () => this.jumpHit(-1), { h: 24, px: 7, bg: t.popover }))
      .child(this.btn(t, "find-next", "↓", () => this.jumpHit(1), { h: 24, px: 7, bg: t.popover }))
      .child(this.btn(t, "find-close", "×", () => { this.find.open = false; this.handle.focus(); }, { h: 24, px: 7, bg: t.popover }));
  }

  // ---- main area ----
  diffBody(t, doc) {
    const size = 12, rowH = 20, cw = 7.25, g = Math.max(3, String(Math.max(1, ...doc.rows.map(r => Math.max(r.old ?? 0, r.new ?? 0)))).length);
    const gw = Math.ceil(g * cw) + 12;
    const addBg = t.ansi2 + "1f", delBg = t.ansi1 + "22", addGut = t.ansi2 + "33", delGut = t.ansi1 + "38";
    const rows = this.diffRowsOf(doc), id = `${doc.key}-${this.split}`;
    const hits = this.findHits(rows), cur = hits.length ? hits[Math.min(this.find.at, hits.length - 1)] : -1;
    const sel = (el, i, side) => this.selectable(el, id, i, side, t);
    const hunk = (r, i) => sel(h_flex().w_full().h(rowH).flex_none().px(12).gap(8).items_center().bg(t.accent + "14").text_color(t.accent)
      .child(div().child("⋯")).child(div().truncate().text_color(t.muted).child(this.mark(r.text, t, i === cur))), i, null);
    const note = (r, i) => sel(div().w_full().h(rowH).px(12).text_color(t.dim).child(this.mark(r.text, t, i === cur)), i, null);
    const cell = (r, side, i) => {
      if (!r) return div().flex_1().min_w(0).h_full().bg(t.raised + "80");
      const k = side === "l" && r.kind === " " ? " " : r.kind;
      const bg = k === "+" ? addBg : k === "-" ? delBg : null, gut = k === "+" ? addGut : k === "-" ? delGut : null;
      const num = side === "l" ? r.old : side === "r" ? r.new : null;
      return sel(h_flex().flex_1().min_w(0).h_full().when(Boolean(bg), e => e.bg(bg))
        .child(div().w(gw).flex_none().h_full().pr(8).text_right().text_color(t.dim).when(Boolean(gut), e => e.bg(gut)).child(num === undefined ? "" : String(num)))
        .child(div().w(16).flex_none().text_center().text_color(k === "+" ? t.ansi2 : k === "-" ? t.ansi1 : t.dim).child(k === " " ? "" : k))
        .child(div().flex_1().min_w(0).truncate().child(this.mark(r.text, t, i === cur))), i, side);
    };
    const unifiedRow = (r, i) => {
      if (r.kind === "@") return hunk(r, i);
      if (r.kind === "") return note(r, i);
      const bg = r.kind === "+" ? addBg : r.kind === "-" ? delBg : null, gut = r.kind === "+" ? addGut : r.kind === "-" ? delGut : null;
      return sel(h_flex().w_full().h(rowH).flex_none().when(Boolean(bg), e => e.bg(bg))
        .child(div().w(gw).flex_none().h_full().pr(6).text_right().text_color(t.dim).when(Boolean(gut), e => e.bg(gut)).child(r.old === undefined ? "" : String(r.old)))
        .child(div().w(gw).flex_none().h_full().pr(8).text_right().text_color(t.dim).when(Boolean(gut), e => e.bg(gut)).child(r.new === undefined ? "" : String(r.new)))
        .child(div().w(18).flex_none().text_center().text_color(r.kind === "+" ? t.ansi2 : r.kind === "-" ? t.ansi1 : t.dim).child(r.kind === " " ? "" : r.kind))
        .child(div().flex_1().child(this.mark(r.text, t, i === cur))), i, null);
    };
    const splitRow = (r, i) => r.kind === "pair"
      ? h_flex().w_full().h(rowH).flex_none().child(cell(r.l, "l", i)).child(div().w(1).h_full().bg(t.border)).child(cell(r.r, "r", i))
      : r.kind === "@" ? hunk(r, i) : note(r, i);
    const list = v_virtual_list(`diff-${id}`, rows.length, rowH, i => String(i),
      range => this.safeRows(rows.slice(range.start, range.end), range.start, this.split ? splitRow : unifiedRow, t, rowH)).track_scroll(this.diffScroll).size_full();
    return div().id(`diffbody-${id}`).flex_1().min_h(0).relative().font_family(mono()).text_size(size).bg(t.background)
      .on_mouse_down("left", (e, cx) => this.diffMouseDown(e, cx, id, rows.length, rowH))
      .on_mouse_move((e, cx) => this.diffMouseMove(e, cx, id, rows.length, rowH))
      .child(this.split ? list
        : div().id(`diffx-${doc.key}`).size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(gw * 2 + 40 + (doc.longest ?? 80) * cw).h_full().child(list)))
      .child(Scrollbar.vertical(`diff-${id}`).viewport_from_layout().absolute().inset_0())
      .when(this.find.open, e => e.child(this.findBar(t, hits)));
  }

  diffView(t, doc) {
    const dir = doc.path.includes("/") ? doc.path.slice(0, doc.path.lastIndexOf("/") + 1) : "";
    const label = doc.from === "--cached" ? "HEAD → staged" : doc.from === "" ? (doc.untracked ? "new file" : "staged → working tree")
      : doc.to === null && doc.from !== "HEAD" && doc.from !== EMPTY_TREE ? `${shortSha(doc.from)} → working tree`
      : doc.to === null ? "HEAD → working tree" : `${shortSha(doc.from)} → ${shortSha(doc.to)}`;
    return v_flex().flex_1().min_h(0)
      .child(h_flex().h(38).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).bg(t.surface)
        .child(this.badge(base(doc.path), 10))
        .child(h_flex().min_w(0).flex_shrink(1).child(div().truncate().text_color(t.dim).child(dir)).child(div().flex_none().font_weight(600).child(base(doc.path))))
        .child(div().px(6).py(1).rounded(4).text_size(10).bg(this.statusColor(t, doc.status) + "26").text_color(this.statusColor(t, doc.status)).child(STATUS[doc.status] ?? "Changed"))
        .child(div().text_size(11).text_color(t.dim).truncate().child(label))
        .child(div().flex_1())
        .child(div().text_size(12).text_color(t.ansi2).child(`+${doc.add}`)).child(div().text_size(12).text_color(t.ansi1).child(`−${doc.del}`))
        .child(h_flex().id("diff-mode").p(2).gap(2).rounded(7).bg(t.raised).tooltip("Show only the changed parts, or the whole file with the changes marked")
          .child(this.btn(t, "m-changes", "Changes", cx => this.setFullFile(false, cx), { active: !this.fullFile, h: 22, px: 8, bg: t.raised }))
          .child(this.btn(t, "m-full", "Full file", cx => this.setFullFile(true, cx), { active: this.fullFile, h: 22, px: 8, bg: t.raised })))
        .child(h_flex().p(2).gap(2).rounded(7).bg(t.raised)
          .child(this.btn(t, "m-uni", "Unified", () => { this.split = false; this.persist(); }, { active: !this.split, h: 22, px: 8, bg: t.raised }))
          .child(this.btn(t, "m-split", "Split", () => { this.split = true; this.persist(); }, { active: this.split, h: 22, px: 8, bg: t.raised })))
        .when(doc.status !== "D", el => el.child(this.btn(t, "open-file", "Open file", cx => this.open(`${doc.repo.root}/${doc.path}`, doc.repo.on, cx, true), { icon: "file", h: 26 }))))
      .child(doc.loading ? div().p(16).text_color(t.dim).child("Loading diff…")
        : doc.error ? div().p(16).text_color(t.ansi1).child(doc.error)
        : this.diffBody(t, doc));
  }

  // One row of the history graph, drawn with boxes: lanes are 2px lines, a commit is a dot,
  // a merge or a branch-off is an elbow from the dot's lane to the other lane.
  graphCell(t, row, w, h, colors, head) {
    const lane = 14, x = i => 9 + i * lane, mid = Math.round(h / 2), els = [];
    if (!row) return div().w(w).h(h).flex_none();
    const color = i => colors[i % colors.length];
    const v = (i, y0, y1) => els.push(div().absolute().left(x(i) - 1).top(y0).w(2).h(Math.max(1, y1 - y0)).bg(color(i)));
    const hz = (a, b, i) => els.push(div().absolute().left(Math.min(x(a), x(b)) - 1).top(mid - 1).w(Math.abs(x(a) - x(b)) + 2).h(2).bg(color(i)));
    for (const i of row.pass) v(i, 0, h);
    if (row.top) v(row.col, 0, mid);
    if (row.bottom) v(row.col, mid, h);
    for (const j of row.into) { v(j, 0, mid); hz(j, row.col, j); }
    for (const k of row.out) { v(k, mid, h); hz(row.col, k, k); }
    const r = head ? 6 : 4;
    els.push(div().absolute().left(x(row.col) - r).top(mid - r).w(r * 2).h(r * 2).rounded(r)
      .bg(head ? t.background : color(row.col)).border_2().border_color(color(row.col)));
    return div().w(w).h(h).flex_none().relative().children(els);
  }

  // Renders list rows one by one, so a bad row shows its error instead of blanking the list.
  safeRows(items, start, render, t, h) {
    return items.map((item, k) => {
      try { return render(item, start + k); }
      catch (e) { return div().h(h).px(12).text_size(11).text_color(t.ansi1).child(`Row error: ${e?.message ?? e}`); }
    });
  }

  refBadge(t, ref) {
    const c = ref.kind === "head" ? t.accent : ref.kind === "tag" ? t.ansi3 : ref.kind === "remote" ? t.ansi4 : t.ansi2;
    return h_flex().flex_none().h(18).px(6).gap(3).items_center().rounded(9).text_size(10).font_weight(600)
      .bg(ref.kind === "head" ? c : c + "22").text_color(ref.kind === "head" ? t.accent_foreground : c).border_1().border_color(c + "66")
      .child(ref.kind === "tag" ? "🏷" : ref.kind === "head" ? "●" : "").child(ref.name);
  }

  graphView(t) {
    const g = this.graph, rowH = 28;
    const colors = [t.ansi4, t.ansi2, t.ansi5, t.ansi3, t.ansi6, t.ansi1, t.accent];
    const w = 16 + (g.layout?.width ?? 1) * 14;
    const headSha = g.commits.find(c => c.refs.some(r => r.kind === "head"))?.sha;
    const row = (c, i) => {
      const sel = g.selected === c.sha;
      return h_flex().id(`cm-${c.sha}`).w_full().h(rowH).flex_none().pr(12).gap(8).items_center().cursor_pointer()
        .bg(sel ? t.selected : t.background).hover(s => s.bg(sel ? t.selected : t.hover))
        .child(this.graphCell(t, g.layout.rows[i], w, rowH, colors, c.sha === headSha))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .children(c.refs.slice(0, 4).map(r => this.refBadge(t, r)))
          .child(div().flex_1().min_w(0).truncate().text_color(c.parents.length > 1 ? t.muted : t.foreground).child(c.subject)))
        .child(div().w(130).flex_none().truncate().text_size(12).text_color(t.muted).child(c.author))
        .child(div().w(40).flex_none().text_right().text_size(12).text_color(t.dim).child(relTime(c.at)))
        .child(div().w(62).flex_none().text_right().font_family(mono()).text_size(11).text_color(t.dim).child(shortSha(c.sha)));
    };
    const d = g.detail;
    return v_flex().flex_1().min_h(0)
      .child(h_flex().h(38).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).bg(t.surface)
        .child(svg("mods/code/git-graph.svg").size(15).text_color(t.accent))
        .child(div().font_weight(600).child("History"))
        .child(div().text_size(11).text_color(t.dim).child(g.loading ? "loading…" : `${g.commits.length} commits`))
        .child(div().flex_1())
        .child(h_flex().p(2).gap(2).rounded(7).bg(t.raised)
          .child(this.btn(t, "g-cur", `This branch (${this.repo?.current ?? "HEAD"})`, cx => { g.all = false; this.loadGraph(cx); }, { active: !g.all, h: 22, px: 8, bg: t.raised }))
          .child(this.btn(t, "g-all2", "All branches", cx => { g.all = true; this.loadGraph(cx); }, { active: g.all, h: 22, px: 8, bg: t.raised })))
        .when(g.commits.length >= g.limit, el => el.child(this.btn(t, "g-more", "Load more", cx => { g.limit += 400; this.loadGraph(cx); }, { h: 24 })))
        .child(this.btn(t, "g-ref", null, cx => this.loadGraph(cx), { icon: "refresh", h: 24, px: 7 })))
      .child(h_flex().h(26).flex_none().px(12).gap(14).items_center().text_size(11).text_color(t.dim).bg(t.background).border_b(1).border_color(t.border)
        .child(h_flex().gap(5).items_center().child(div().w(8).h(8).rounded(4).bg(t.ansi4)).child("a commit"))
        .child(h_flex().gap(5).items_center().child(div().w(2).h(12).bg(t.ansi2)).child("a branch line (each color is a branch)"))
        .child(h_flex().gap(5).items_center().child(div().w(10).h(10).rounded(5).border_2().border_color(t.accent)).child("where you are (HEAD)"))
        .child(div().flex_1())
        .child(div().child("Click a commit to see the files it changed")))
      .when(Boolean(g.layout), el => el.child(h_flex().h(24).flex_none().pr(12).gap(8).items_center().text_size(10).font_weight(600).text_color(t.dim).border_b(1).border_color(t.border)
        .child(div().w(w).flex_none().pl(8).child("GRAPH"))
        .child(div().flex_1().child("MESSAGE"))
        .child(div().w(130).flex_none().child("AUTHOR"))
        .child(div().w(40).flex_none().text_right().child("WHEN"))
        .child(div().w(62).flex_none().text_right().child("COMMIT"))))
      .child(!this.repo ? div().p(16).text_color(t.dim).child("Not a git repository")
        : g.error ? div().p(16).text_color(t.ansi1).child(g.error)
        : !g.layout ? div().p(16).text_color(t.dim).child("Loading commits…")
        : div().flex_1().min_h(0).relative().text_size(13)
          .child(v_virtual_list("graph-list", g.commits.length, rowH, i => g.commits[i].sha,
            range => this.safeRows(g.commits.slice(range.start, range.end), range.start, row, t, rowH)).track_scroll(this.graphScroll)
            .on_item_click((key, cx) => { const c = g.commits.find(x => x.sha === key); if (c) this.selectCommit(c, cx); }).size_full())
          .child(Scrollbar.vertical("graph-list").viewport_from_layout().absolute().inset_0()))
      .when(Boolean(d), el => el.child(h_flex().h(270).flex_none().border_t(1).border_color(t.border).bg(t.surface)
        .child(v_flex().w(340).flex_none().p(14).gap(8).border_r(1).border_color(t.border)
          .child(div().font_weight(600).text_size(14).child(d.commit.subject))
          .child(h_flex().gap(6).flex_wrap().children(d.commit.refs.map(r => this.refBadge(t, r))))
          .child(div().text_size(12).text_color(t.muted).child(`${d.commit.author} · ${new Date(d.commit.at).toLocaleString()}`))
          .child(div().font_family(mono()).text_size(11).text_color(t.dim).child(d.commit.sha))
          .when(d.commit.parents.length > 0, el => el.child(div().font_family(mono()).text_size(11).text_color(t.dim)
            .child(`parent${d.commit.parents.length > 1 ? "s" : ""}: ${d.commit.parents.map(shortSha).join(", ")}`)))
          .when(Boolean(d.files), el => el.child(h_flex().gap(10).text_size(12)
            .child(div().child(`${d.files.length} files`))
            .child(div().text_color(t.ansi2).child(`+${this.sumStats(d.files).add}`))
            .child(div().text_color(t.ansi1).child(`−${this.sumStats(d.files).del}`))))
          .child(div().flex_1())
          .child(this.btn(t, "g-close", "Close details", () => { g.selected = null; g.detail = null; }, { h: 24 })))
        .child(v_flex().id("commit-files").flex_1().min_w(0).overflow_y_scrollbar().p(4).text_size(13)
          .children(d.files ? this.changeTree(t, `g${shortSha(d.commit.sha)}`, d.files,
            f => ({ from: d.commit.parents[0] ?? EMPTY_TREE, to: d.commit.sha, path: f.path, status: f.status })) : [])
          .when(!d.files, el => el.child(div().p(10).text_size(12).text_color(d.error ? t.ansi1 : t.dim).child(d.error || "Loading files…"))))));
  }

  fileView(t, doc, i) {
    const button = (id, label, onClick, strong) => this.btn(t, id, label, onClick, { strong, h: 24 });
    const banner = (text, actions, color) => h_flex().flex_none().px(12).py(6).gap(8).items_center().bg(t.raised).border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).text_size(12).text_color(color ?? t.foreground).child(text)).children(actions);
    const rel = this.repo && doc.path.startsWith(this.repo.root + "/") ? doc.path.slice(this.repo.root.length + 1) : null;
    const change = rel && (this.work.unstaged.find(f => f.path === rel) ?? this.work.staged.find(f => f.path === rel));
    return v_flex().flex_1().min_h(0)
      .child(h_flex().h(28).flex_none().px(12).gap(6).items_center().text_size(11).text_color(t.dim).bg(t.background)
        .child(div().flex_1().min_w(0).truncate().child((doc.on ? `${doc.on}: ` : "") + doc.path))
        .when(Boolean(change), el => el.child(this.btn(t, "f-diff", `View changes (${change.status})`, cx => this.openDiff(
          this.workDiff(change, !this.work.unstaged.includes(change)), cx, true), { h: 20, px: 8 }))))
      .when(Boolean(doc.conflict), el => el.child(banner("This file changed on disk since you opened it.", [
        button("c-reload", "Reload from disk", cx => this.reload(i, cx)),
        button("c-overwrite", "Overwrite", cx => this.save(i, cx, true), true)], t.blocked)))
      .when(Boolean(doc.confirmClose), el => el.child(banner(`Save changes to ${base(doc.path)}?`, [
        button("q-save", "Save", cx => { doc.closeAfter = true; this.save(i, cx, false); }, true),
        button("q-discard", "Don't save", () => this.drop(doc)),
        button("q-cancel", "Cancel", () => { doc.confirmClose = false; })])))
      .child(doc.error ? div().p(16).text_color(t.dim).child(doc.error)
        : !doc.state ? div().p(16).text_color(t.dim).child("Loading…")
        : Editor.new(doc.state).flex_1().min_h(0));
  }

  tabTitle(d) {
    if (d.kind === "graph") return { name: "History", icon: "git-graph" };
    if (d.kind === "diff") return { name: base(d.path), sub: d.to ? "commit" : d.from === "--cached" ? "staged" : d.from === "" || d.from === "HEAD" || d.from === EMPTY_TREE ? "changes" : "compare" };
    return { name: base(d.path), sub: d.on ? `@${d.on}` : null };
  }

  render(cx) {
    try { return this.renderInner(cx); }
    catch (e) { return div().p(20).text_color(theme().ansi1).child(`Render error: ${e?.message ?? e}
${e?.stack ?? ""}`); }
  }

  // When this Editor tab becomes the shown one (opened, or switched to), take the keyboard,
  // so editor keys (Ctrl+F4, Ctrl+S, Ctrl+W) work without clicking inside first.
  autoFocus(cx) {
    const f = focused(), pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
    const sp = spaces().find(s => s.id === this.space);
    const shown = Boolean(pane && pane.mod === "code" && sp?.active && sp.tabs.some(t => t.id === pane.tab));
    if (shown && !this.wasShown) {
      cx.spawn(async cx => {
        await cx.sleep(30);
        const d = this.docs[this.active];
        if (d?.state) d.state.focus(); else this.handle.focus();
        cx.notify();
      });
    }
    this.wasShown = shown;
  }

  renderInner(cx) {
    if (this.dedupe()) return div();
    if (!checking()) this.autoFocus(cx);
    this.takeRequest(cx);
    const t = theme(), doc = this.docs[this.active];

    // ---- top bar: views + repo ----
    const changes = new Set([...this.work.staged, ...this.work.unstaged].map(f => f.path)).size, compact = (this.width ?? 1400) < 1050;
    const top = h_flex().h(40).flex_none().px(8).gap(4).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(this.btn(t, "sb", null, () => { this.sidebar = !this.sidebar; }, { icon: "sidebar", px: 7, h: 28, bg: t.chrome, active: this.sidebar }))
      .child(div().w(1).h(20).mx(4).bg(t.border))
      .children(VIEWS.map(v => {
        const on = this.view === v.id;
        return h_flex().id(`view-${v.id}`).h(30).px(12).gap(7).items_center().rounded(7).cursor_pointer().text_size(13)
          .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
          .when(on, el => el.border_1().border_color(t.border))
          .hover(s => s.bg(on ? t.selected : t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.setView(v.id, cx); cx.notify(); })
          .child(svg(`mods/code/${v.icon}.svg`).size(15).flex_none().text_color(on ? t.accent : t.muted))
          .when(!compact || on, el => el.child(v.label))
          .when(v.id === "changes" && changes > 0, el => el.child(div().h(16).min_w(16).px(5).rounded(8).bg(t.accent)
            .text_color(t.accent_foreground).text_size(10).font_weight(700).flex().items_center().justify_center().child(String(changes))));
      }))
      .child(div().flex_1())
      .when(Boolean(this.repo), el => el.child(h_flex().id("repo-pill").h(28).px(10).gap(6).items_center().rounded(14).bg(t.raised).text_size(12).cursor_pointer()
        .hover(s => s.bg(t.hover)).tooltip("Switch branch")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { this.branchMenu = !this.branchMenu; this.branchNote = null; this.branchFilter.set_value(""); if (this.branchMenu) this.loadRepo(cx); cx.notify(); })
        .child(svg("mods/code/git-branch.svg").size(13).text_color(t.ansi2))
        .child(div().max_w(compact ? 140 : 260).truncate().font_weight(600).child(this.repo.current))
        .child(svg(`mods/code/chevron-${this.branchMenu ? "down" : "right"}.svg`).size(10).text_color(t.dim))
        .when(!compact, el => el.child(div().text_color(t.dim).child(base(this.repo.root))))))
      .when(Boolean(this.on) && !compact, el => el.child(div().px(8).h(22).flex().items_center().rounded(11).text_size(11).bg(t.ansi4 + "22").text_color(t.ansi4).child(`SSH ${this.on}`)))
      .child(this.btn(t, "refresh-all", null, cx => this.refreshAll(cx), { icon: "refresh", px: 7, h: 28, bg: t.chrome }));

    // ---- sidebar ----
    const side = !this.sidebar ? null : v_flex().w(Math.min(this.sideW, Math.max(180, (this.width ?? 1400) - 360))).h_full().flex_none().min_h(0).bg(t.chrome).border_r(1).border_color(t.border)
      .child(this.view === "explorer" ? this.sideExplorer(t) : this.view === "changes" ? this.sideChanges(t)
        : this.view === "compare" ? this.sideCompare(t) : this.sideGraph(t));

    // ---- tabs ----
    const tabs = h_flex().id("code-tabs").h(36).w_full().flex_none().overflow_x_scroll().bg(t.chrome).border_b(1).border_color(t.border)
      .children(this.docs.map((d, i) => {
        const on = i === this.active, info = this.tabTitle(d);
        return h_flex().id(`doc-${i}`).h_full().flex_none().pl(10).pr(6).gap(6).items_center().cursor_pointer()
          .bg(on ? t.background : t.chrome).border_r(1).border_color(t.border)
          .when(on, el => el.border_t(2).border_color(t.accent))
          .hover(s => s.bg(on ? t.background : t.hover))
          .on_click((e, cx) => { this.active = i; if (e.click_count >= 2 && d.preview) d.preview = false; d.state?.focus(); this.persist(); cx.notify(); })
          .on_mouse_down("middle", (_e, cx) => this.close(i, cx))
          .child(info.icon ? svg(`mods/code/${info.icon}.svg`).size(13).text_color(t.accent) : d.kind === "diff"
            ? div().w(16).text_size(11).font_weight(700).text_color(this.statusColor(t, d.status)).child(d.status ?? "Δ") : this.badge(info.name))
          .child(div().text_size(12).text_color(on ? t.foreground : t.muted).when(d.preview, e => e.text_color(t.dim)).child(info.name))
          .when(Boolean(info.sub), el => el.child(div().text_size(10).text_color(t.dim).child(info.sub)))
          .child(div().id(`close-${i}`).w(18).h(18).flex().items_center().justify_center().rounded(4).text_size(12)
            .text_color(d.dirty ? t.foreground : t.dim).hover(s => s.bg(t.hover))
            .on_click((_e, cx) => { cx.stop_propagation(); this.close(i, cx); })
            .child(d.dirty ? "●" : "×"));
      }));

    let body;
    if (!doc) body = v_flex().flex_1().items_center().justify_center().gap(8).text_color(t.dim)
      .child(div().text_size(16).text_color(t.muted).child("Nothing open"))
      .child(div().text_size(12).child("Explorer: open files · Changes: your uncommitted diff · Compare: branch vs main · Graph: history"))
      .child(div().text_size(12).child("Ctrl+S save · Ctrl+W close · Ctrl+B sidebar · double-click a diff to keep its tab"));
    else if (doc.kind === "graph") body = this.graphView(t);
    else if (doc.kind === "diff") body = this.diffView(t, doc);
    else body = this.fileView(t, doc, this.active);

    const main = v_flex().flex_1().h_full().min_w(0).min_h(0).bg(t.background).child(tabs).child(body);

    // ---- status bar ----
    const fdoc = doc?.kind === "file" ? doc : null, text = fdoc?.state?.value();
    const status = h_flex().h(24).flex_none().px(10).gap(14).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11).text_color(t.muted)
      .child(div().child(this.on ? `SSH: ${this.on}` : "Local"))
      .when(Boolean(this.repo), el => el.child(h_flex().gap(4).items_center().child(svg("mods/code/git-branch.svg").size(11)).child(this.repo.current))
        .child(div().text_color(changes ? t.ansi3 : t.dim).child(changes ? `${changes} changed` : "clean")))
      .child(div().flex_1().min_w(0).truncate().text_color(this.message?.startsWith("Couldn't") ? t.blocked : t.muted).child(fdoc?.saving ? "Saving…" : this.message ?? ""))
      .when(Boolean(fdoc?.state), el => el
        .child(div().child(`${text.split("\n").length} lines`))
        .child(div().child(fdoc.crlf ? "CRLF" : "LF"))
        .child(div().child("UTF-8"))
        .child(div().child(languageOf(fdoc.path)[1]))
        .child(div().id("st-save").px(8).rounded(4).cursor_pointer().bg(fdoc.dirty ? t.solid : t.raised).text_color(fdoc.dirty ? t.solid_foreground : t.muted)
          .on_click((_e, cx) => this.save(this.active, cx, false)).child(fdoc.dirty ? "Save" : "Saved")));

    return v_flex().id("code").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).track_focus(this.handle).relative()
      .on_mouse_down("left", (_e, cx) => { if (this.branchMenu) { this.branchMenu = false; cx.notify(); } if (!this.docs[this.active]?.state) this.handle.focus(); })
      .on_window_mouse_move((e, cx) => {
        if (!this.drag) return;
        if (e.pressed_button !== "left") { this.drag = null; this.persist(); cx.notify(); return; }
        const w = this.drag.w + (e.position.x - this.drag.x) / (settings().zoom || 1);
        if (w < 120) this.sidebar = false;
        else { this.sidebar = true; this.sideW = Math.round(Math.min(800, Math.max(180, w))); }
        cx.notify();
      })
      .on_window_mouse_up("left", (_e, cx) => { if (this.sel) this.sel.drag = false; if (this.drag) { this.drag = null; this.persist(); cx.notify(); } })
      .on_key_down((e, cx) => this.diffKey(e, cx))
      .on_size_change((size, cx) => { const w = size.width / (settings().zoom || 1); if (Math.abs((this.width ?? 0) - w) > 20) { this.width = w; cx.notify(); } })
      .child(top)
      .child(h_flex().items_stretch().flex_1().min_h(0).min_w(0).when(Boolean(side), el => el.child(side))
        .when(Boolean(side), el => el.child(div().id("side-resize").w(6).h_full().flex_none().ml(-3).cursor_col_resize()
          .when(Boolean(this.drag), e => e.bg(t.accent)).hover(s => s.bg(t.accent))
          .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.drag = { x: e.position.x, w: this.sideW }; cx.notify(); })
          .on_click((e, cx) => { if (e.click_count >= 2) { this.sideW = 300; this.persist(); cx.notify(); } })))
        .child(main))
      .child(status)
      .when(this.branchMenu && Boolean(this.repo), el => el.child(this.branchPanel(t)));
  }
}
