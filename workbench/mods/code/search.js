// Search in files with `git grep`: fast, the same on this computer and on ssh machines, honours
// .gitignore, and with --no-index also works in folders that aren't a git repo.
import { exec, window as hwin } from "herdr";

export const MAX_MATCHES = 5000;   // rows kept for the list
const PER_FILE = 200;              // matches per file asked of git

// "node_modules, *.min.js, src/gen/" -> git glob pathspecs that match at any depth, folder or file.
function pathspecs(text, exclude) {
  const out = [];
  for (let p of String(text || "").split(",")) {
    p = p.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (!p) continue;
    const anchored = p.startsWith("/");
    p = p.replace(/^\/+/, "");
    if (!anchored && !p.startsWith("**/")) p = `**/${p}`;
    const magic = exclude ? ":(exclude,glob)" : ":(glob)";
    out.push(magic + p, magic + p + "/**");
  }
  return out;
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The same search as a JS regex, to find every match's place in a line (UTF-16 offsets).
export function matcher(o) {
  if (!o.query) return null;
  try {
    let src = o.regex ? o.query : escapeRe(o.query);
    if (o.word) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
    return new RegExp(src, "gu" + (o.matchCase ? "" : "i"));
  } catch { return null; }
}

function ranges(re, text, fallbackCol, len) {
  const out = [];
  if (re) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(text)) && out.length < 50;) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      out.push([m.index, m.index + m[0].length]);
    }
  }
  if (!out.length) { const s = Math.max(0, Math.min(text.length, fallbackCol - 1)); out.push([s, Math.min(text.length, s + Math.max(1, len))]); }
  return out;
}

// Folders never worth walking outside a repo (in a repo, .gitignore decides).
const HEAVY = ["node_modules", ".git", "dist", "build", ".next", "target", "vendor", ".venv", "venv", "__pycache__", ".cache",
  "AppData", "Library", ".npm", ".pnpm-store", ".cargo", ".rustup", ".gradle", ".m2", ".nuget", ".local", "go", "snap", ".Trash"];
const NOT_REPO = /not a git repository|outside repository|--no-index/i;

// o: { query, matchCase, word, regex, include, exclude, ignore }
// -> { files: [{ path, matches: [{ line, text, start, end }] }], total, limited, shallow }
// Tracked + untracked files of the repo the folder is in; { notRepo: true } outside a repo.
export async function searchFiles(root, on, o) {
  const base = ["-c", "core.quotepath=off", "grep", "-n", "--column", "-I", "--no-color", "-m", String(PER_FILE)];
  if (!o.matchCase) base.push("-i");
  if (o.word) base.push("-w");
  const inc = pathspecs(o.include, false), exc = pathspecs(o.exclude, true);
  const run = (scope, mode) => exec("git", [...base, ...scope, mode, "-e", o.query, "--", ...(inc.length ? inc : ["."]), ...exc,
  ], { cwd: root, on, timeout: 30000 });
  const attempt = async scope => {
    let r = await run(scope, o.regex ? "-P" : "-F");
    if (o.regex && r.code > 1 && /PCRE|perl/i.test(r.stderr)) r = await run(scope, "-E");   // git built without PCRE
    return r;
  };
  // Outside a repo git grep --no-index walks the whole tree whatever the depth (a home folder takes
  // minutes and lots of memory), so search only runs inside a repo.
  const r = await attempt(["--untracked", ...(o.ignore ? [] : ["--no-exclude-standard"])]);
  if (r.code > 1 && NOT_REPO.test(r.stderr)) return { files: [], total: 0, limited: false, notRepo: true };
  if (r.code > 1) throw new Error((r.stderr || "Search failed").trim().split("\n").slice(0, 2).join(" "));
  const re = matcher(o), files = [], byPath = new Map();
  let total = 0, limited = false;
  for (const raw of r.stdout.split("\n")) {
    if (!raw) continue;
    // path:line:col:text (no -z: NUL bytes don't come through exec everywhere)
    const hit = /^(.*?):(\d+):(\d+):/.exec(raw);
    if (!hit) continue;
    const path = hit[1], line = Number(hit[2]), col = Number(hit[3]);
    const text = raw.slice(hit[0].length).replace(/\r$/, "");
    let f = byPath.get(path);
    if (!f) { f = { path, matches: [] }; byPath.set(path, f); files.push(f); }
    for (const [start, end] of ranges(re, text, col, o.query.length)) {
      if (total >= MAX_MATCHES) { limited = true; break; }
      f.matches.push({ line, text, start, end }); total++;
    }
    if (limited) break;
  }
  if (!limited && files.some(f => f.matches.length >= PER_FILE)) limited = true;
  return { files, total, limited };
}

// ---- quick open (Ctrl+P) ----

export const MAX_FILES = 20000;
const WALK_DEPTH = 8;

// Every file under root, relative. In a repo: git's list (tracked + untracked, not ignored).
// Elsewhere: file NAMES only (never contents), at most MAX_FILES and WALK_DEPTH levels, skipping HEAVY.
export async function listFiles(root, on) {
  const g = await exec("git", ["-c", "core.quotepath=off", "ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, on, timeout: 30000 });
  if (g.code === 0) return [...new Set(g.stdout.split("\n").map(s => s.replace(/\r$/, "")).filter(Boolean))].slice(0, MAX_FILES * 5);
  const windows = async () => {
    const skip = HEAVY.map(h => `'${h}'`).join(",");
    const script = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($root) " +
      `$skip = [Collections.Generic.HashSet[string]]::new([string[]]@(${skip}), [StringComparer]::OrdinalIgnoreCase); ` +
      "$q = [Collections.Generic.Queue[object]]::new(); $q.Enqueue(@($root, 0)); $n = 0; $out = [Text.StringBuilder]::new(); " +
      `while ($q.Count -and $n -lt ${MAX_FILES}) { $d = $q.Dequeue(); ` +
      "try { foreach ($f in [IO.Directory]::EnumerateFiles($d[0])) { [void]$out.Append($f.Substring($root.Length + 1)).Append(\"`n\"); $n++; " +
      `if ($n -ge ${MAX_FILES}) { break } } } catch {} ` +
      `if ($d[1] -lt ${WALK_DEPTH}) { try { foreach ($s in [IO.Directory]::EnumerateDirectories($d[0])) { $name = [IO.Path]::GetFileName($s); ` +
      "if (-not $skip.Contains($name) -and -not (([IO.File]::GetAttributes($s)) -band [IO.FileAttributes]::ReparsePoint)) { $q.Enqueue(@($s, $d[1] + 1)) } } } catch {} } } " +
      "[Console]::Out.Write($out.ToString()) }";
    const r = await exec("powershell", ["-NoProfile", "-Command", `${script} '${root.replace(/'/g, "''")}'`], { on, timeout: 30000 });
    if (r.code !== 0) throw new Error((r.stderr || "Can't list the files").trim().split("\n")[0]);
    return r.stdout.split("\n").map(s => s.replace(/\r$/, "").replace(/\\/g, "/")).filter(Boolean);
  };
  if (!on && hwin()?.platform === "windows") return windows();
  const prune = HEAVY.map(h => `-name '${h}'`).join(" -o ");
  let r;
  try {
    r = await exec("sh", ["-c", `cd "$1" && find . -maxdepth ${WALK_DEPTH} \\( ${prune} \\) -prune -o -type f -print 2>/dev/null | head -n ${MAX_FILES}`, "list", root], { on, timeout: 30000 });
  } catch (e) {
    if (on && String(e).includes("program not found")) return windows();
    throw e;
  }
  return r.stdout.split("\n").map(s => s.replace(/^\.\//, "")).filter(Boolean);
}

const WORD = /[\/\._\-\s]/;
function subseq(q, text, from, lower) {
  const hits = [];
  let i = from;
  for (const ch of q) {
    const k = lower.indexOf(ch, i);
    if (k < 0) return null;
    hits.push(k); i = k + 1;
  }
  return hits;
}

// Fuzzy match like VS Code's quick open: the query's letters in order, preferring the file name,
// runs of letters and word starts. q is lowercase without spaces. -> { score, hits } or null.
export function fuzzy(q, path) {
  const lower = path.toLowerCase(), nameAt = path.lastIndexOf("/") + 1;
  let hits = subseq(q, path, nameAt, lower), inName = Boolean(hits);
  if (!hits) hits = subseq(q, path, 0, lower);
  if (!hits) return null;
  let score = inName ? 40 : 0;
  for (let n = 0; n < hits.length; n++) {
    const k = hits[n];
    if (n && hits[n - 1] === k - 1) score += 6;
    if (k === 0 || WORD.test(path[k - 1]) || (path[k] !== lower[k] && path[k - 1] === lower[k - 1])) score += 4;
    if (k >= nameAt) score += 1;
  }
  if (inName && lower.startsWith(q, nameAt)) score += 25;
  if (inName && lower.length - nameAt === q.length) score += 30;
  score -= path.length * 0.05 + (path.split("/").length - 1) * 0.5;
  return { score, hits };
}
