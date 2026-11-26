// Search in files with `git grep`: fast, the same on this computer and on ssh machines, honours
// .gitignore, and with --no-index also works in folders that aren't a git repo.
import { exec } from "herdr";

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

// o: { query, matchCase, word, regex, include, exclude, ignore, inRepo }
// -> { files: [{ path, matches: [{ line, text, start, end }] }], total, limited }
export async function searchFiles(root, on, o) {
  const args = ["-c", "core.quotepath=off", "grep", "-n", "--column", "-I", "--no-color", "-m", String(PER_FILE)];
  if (o.inRepo) { args.push("--untracked"); if (!o.ignore) args.push("--no-exclude-standard"); }
  else { args.push("--no-index"); if (o.ignore) args.push("--exclude-standard"); }
  if (!o.matchCase) args.push("-i");
  if (o.word) args.push("-w");
  const tail = ["-e", o.query, "--", ...(pathspecs(o.include, false).length ? pathspecs(o.include, false) : ["."]), ...pathspecs(o.exclude, true)];
  const run = mode => exec("git", [...args, mode, ...tail], { cwd: root, on, timeout: 30000 });
  let r = await run(o.regex ? "-P" : "-F");
  if (o.regex && r.code > 1 && /PCRE|perl/i.test(r.stderr)) r = await run("-E");   // git built without PCRE
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
