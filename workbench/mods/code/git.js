// Git helpers for the workbench: status, compare, commits, diffs, graph lanes, trees.
import { exec } from "herdr";

export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-c", "core.quotepath=false"];
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export function gitIn(root, on) {
  return async (args, timeout) => {
    const r = await exec("git", [...READ, ...args], { cwd: root, on, timeout });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `git ${args[0]} failed`);
    return r.stdout;
  };
}

export async function repoRoot(cwd, on) {
  try {
    const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
    return r.code === 0 ? r.stdout.trim() : null;
  } catch { return null; }
}

// Branches (local and remote), the current one, and a sensible base (main, master, ...).
export async function branches(git) {
  const out = await git(["for-each-ref", "--format=%(refname)%09%(refname:short)%09%(HEAD)%09%(objectname:short)", "refs/heads", "refs/remotes"]);
  const list = [];
  let current = null;
  for (const line of out.split("\n").filter(Boolean)) {
    const [full, name, head, sha] = line.split("\t");
    if (full.endsWith("/HEAD")) continue;
    const remote = full.startsWith("refs/remotes/");
    list.push({ name, remote, sha });
    if (head === "*") current = name;
  }
  if (!current) current = "HEAD";
  const names = new Set(list.map(b => b.name));
  const base = ["main", "master", "origin/main", "origin/master", "develop", "origin/develop"].find(n => names.has(n)) ?? list[0]?.name ?? "HEAD";
  return { list, current, base };
}

// "A" added, "M" modified, "D" deleted, "U" conflict, "R" renamed (shown as A/D with --no-renames).
function statusLetter(code) {
  if (code.includes("U")) return "U";
  if (code.includes("D")) return "D";
  if (code.includes("A") || code === "??") return "A";
  return "M";
}

function parseNumstat(out) {
  const stats = {};
  for (const entry of out.split("\0")) {
    const [a, d, ...rest] = entry.split("\t");
    if (!rest.length) continue;
    const path = rest.join("\t").replace(/^\n/, "");
    stats[path] = { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" };
  }
  return stats;
}

function parseNameStatus(out) {
  const files = [], parts = out.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i].trim();
    if (!code) { i--; continue; }
    files.push({ status: statusLetter(code), path: parts[i + 1] });
  }
  return files;
}

// Uncommitted changes, VS Code style: staged (index vs HEAD) and unstaged (worktree vs index, plus untracked).
export async function workingChanges(git) {
  const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
  let hasHead = true;
  try { await git(["rev-parse", "--verify", "HEAD"]); } catch { hasHead = false; }
  const [cached, work] = await Promise.all([
    git(["diff", "--cached", "--numstat", "-z", "--no-renames"]).catch(() => ""),
    git(["diff", "--numstat", "-z", "--no-renames"]).catch(() => ""),
  ]);
  const sStats = parseNumstat(cached), wStats = parseNumstat(work);
  const staged = [], unstaged = [];
  for (const entry of status.split("\0").filter(Boolean).slice(0, 3000)) {
    const x = entry[0], y = entry[1], path = entry.slice(3);
    if (x === "?" ) { unstaged.push({ path, status: "A", untracked: true, add: 0, del: 0 }); continue; }
    const conflict = x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
    if (conflict) { unstaged.push({ path, status: "U", add: 0, del: 0 }); continue; }
    if (x !== " ") staged.push({ path, status: statusLetter(x), ...(sStats[path] ?? { add: 0, del: 0 }) });
    if (y !== " ") unstaged.push({ path, status: statusLetter(y), ...(wStats[path] ?? { add: 0, del: 0 }) });
  }
  return { staged, unstaged, hasHead };
}

export async function pull(git) {
  await git(["pull", "--ff-only", "--no-rebase", "--no-autostash"], 90000);
}

export async function stage(git, paths) { if (paths.length) await git(["add", "-A", "--", ...paths]); }
export async function unstage(git, paths, hasHead) {
  if (!paths.length) return;
  await git(hasHead ? ["restore", "--staged", "--", ...paths] : ["rm", "--cached", "-r", "-q", "--", ...paths]);
}
// Throws away worktree changes: tracked files go back to the index version, untracked files are deleted.
export async function discard(git, files) {
  const tracked = files.filter(f => !f.untracked).map(f => f.path), fresh = files.filter(f => f.untracked).map(f => f.path);
  if (tracked.length) await git(["restore", "--worktree", "--", ...tracked]);
  if (fresh.length) await git(["clean", "-f", "-q", "--", ...fresh]);
}

// Files changed between two points: base and head are refs; head null = working tree.
export async function changedFiles(git, from, to) {
  const range = to ? [from, to] : [from];
  const [ns, num] = await Promise.all([
    git(["diff", "--name-status", "-z", "--no-renames", ...range]),
    git(["diff", "--numstat", "-z", "--no-renames", ...range]),
  ]);
  const stats = parseNumstat(num);
  return parseNameStatus(ns).map(f => ({ ...f, ...(stats[f.path] ?? { add: 0, del: 0 }) }));
}

export async function mergeBase(git, a, b) {
  return (await git(["merge-base", a, b])).trim();
}

export async function aheadBehind(git, base, head) {
  const [behind, ahead] = (await git(["rev-list", "--left-right", "--count", `${base}...${head}`])).trim().split(/\s+/).map(Number);
  return { ahead, behind };
}

// The unified diff of one file, as lines starting at the first hunk.
// full: the whole file as context (one hunk), not just the changed parts.
export async function fileDiff(git, from, to, path, full = false) {
  const out = await git(["diff", ...(to ? [from, to] : from ? [from] : []), "--no-ext-diff", "--no-textconv", "--no-color", full ? "-U1000000" : "-U4", "--", path], 20000);
  const lines = out.replace(/\n$/, "").split("\n"), first = lines.findIndex(l => l.startsWith("@@"));
  if (first < 0) return /Binary files/.test(out) ? ["Binary file changed"] : ["No text changes"];
  return lines.slice(first);
}

const untab = text => text.replace(/[^\t]*\t/g, s => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));
const MAX_ROWS = 6000;

// Unified rows: { kind: "@" | "+" | "-" | " " | "", old, new, text }.
export function unifiedRows(lines) {
  let o = 0, n = 0;
  const rows = [];
  for (const line of lines.slice(0, MAX_ROWS)) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/.exec(line);
    if (m) { o = +m[1]; n = +m[2]; rows.push({ kind: "@", text: m[3].trim() || line }); continue; }
    const k = line[0], text = untab(line.slice(1)).slice(0, 3000) || " ";
    if (k === "-") rows.push({ kind: "-", old: o++, text });
    else if (k === "+") rows.push({ kind: "+", new: n++, text });
    else if (k === " ") rows.push({ kind: " ", old: o++, new: n++, text });
    else if (line.startsWith("\\")) continue;
    else rows.push({ kind: "", text: line });
  }
  return rows;
}

// Side-by-side rows: removed lines pair up with the added lines that follow them.
export function splitRows(rows) {
  const out = [];
  let dels = [], adds = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) out.push({ kind: "pair", l: dels[i] ?? null, r: adds[i] ?? null });
    dels = []; adds = [];
  };
  for (const row of rows) {
    if (row.kind === "-") { if (adds.length) flush(); dels.push(row); }
    else if (row.kind === "+") adds.push(row);
    else { flush(); out.push(row.kind === " " ? { kind: "pair", l: row, r: row } : row); }
  }
  flush();
  return out;
}

export function textAsAdded(text) {
  const lines = text.replace(/\n$/, "").split("\n");
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map(l => "+" + l)];
}

// ---- commit graph ----
const SEP = "\x1f";
export async function commits(git, all, limit) {
  const out = await git(["log", ...(all ? ["--all"] : []), "--topo-order", `-n${limit}`, `--format=%H${SEP}%P${SEP}%D${SEP}%s${SEP}%an${SEP}%at`], 30000);
  return out.split("\n").filter(Boolean).map(line => {
    const [sha, parents, refs, subject, author, at] = line.split(SEP);
    return { sha, parents: parents ? parents.split(" ") : [], refs: parseRefs(refs), subject, author, at: Number(at) * 1000 };
  });
}

function parseRefs(text) {
  const refs = [];
  for (let r of (text || "").split(", ").filter(Boolean)) {
    if (r.startsWith("HEAD -> ")) { refs.push({ kind: "head", name: r.slice(8) }); continue; }
    if (r === "HEAD") { refs.push({ kind: "head", name: "HEAD" }); continue; }
    if (r.startsWith("tag: ")) { refs.push({ kind: "tag", name: r.slice(5) }); continue; }
    if (r.endsWith("/HEAD")) continue;
    refs.push({ kind: r.includes("/") && /^(origin|upstream)\//.test(r) ? "remote" : "branch", name: r });
  }
  return refs;
}

// Lanes: each row says where its dot is and which lines cross, end or start there.
export function layoutGraph(list) {
  const lanes = [], rows = [];
  let width = 1;
  for (const c of list) {
    let col = lanes.indexOf(c.sha);
    const fresh = col < 0;
    if (col < 0) { col = lanes.indexOf(null); if (col < 0) col = lanes.length; lanes[col] = c.sha; }
    const before = lanes.slice();
    const into = [];
    for (let i = 0; i < lanes.length; i++) if (i !== col && lanes[i] === c.sha) { into.push(i); lanes[i] = null; }
    const out = [];
    lanes[col] = c.parents[0] ?? null;
    for (const p of c.parents.slice(1)) {
      let k = lanes.indexOf(p);
      if (k < 0) { k = lanes.indexOf(null); if (k < 0) k = lanes.length; lanes[k] = p; }
      out.push(k);
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const after = lanes.slice();
    const pass = [];
    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      if (i === col || into.includes(i)) continue;
      if (before[i] && after[i] && before[i] === after[i]) pass.push(i);
    }
    width = Math.max(width, before.length, after.length, col + 1);
    rows.push({ col, top: !fresh, bottom: Boolean(lanes[col]), into, out, pass });
  }
  return { rows, width: Math.min(width, 24) };
}

// ---- trees ----
// Builds a folder tree from paths, folding single-child folder chains ("src/app/lib").
export function buildTree(files) {
  const root = { name: "", path: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      if (!node.dirs.has(key)) node.dirs.set(key, { name: key, path: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [] });
      node = node.dirs.get(key);
    }
    node.files.push({ ...f, name: parts[parts.length - 1] });
  }
  const fold = node => {
    for (const [k, d] of node.dirs) {
      let cur = d;
      while (cur.files.length === 0 && cur.dirs.size === 1) {
        const [only] = cur.dirs.values();
        cur = { ...only, name: `${cur.name}/${only.name}` };
      }
      fold(cur);
      node.dirs.set(k, cur);
    }
    return node;
  };
  return fold(root);
}

export function relTime(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 365) return `${Math.floor(s / 86400 / 30)}mo`;
  return `${Math.floor(s / 86400 / 365)}y`;
}
