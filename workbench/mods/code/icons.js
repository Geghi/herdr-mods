// File-type badges: a short label in the language's color (Seti-style), by name then extension.
const BY_EXT = {
  js: ["JS", "#f1e05a"], mjs: ["JS", "#f1e05a"], cjs: ["JS", "#f1e05a"], jsx: ["JSX", "#61dafb"],
  ts: ["TS", "#3178c6"], mts: ["TS", "#3178c6"], cts: ["TS", "#3178c6"], tsx: ["TSX", "#3b9be0"], "d.ts": ["DTS", "#2f6fae"],
  json: ["{}", "#cbcb41"], jsonc: ["{}", "#cbcb41"], json5: ["{}", "#cbcb41"],
  md: ["MD", "#519aba"], mdx: ["MDX", "#519aba"], txt: ["TXT", "#8a8f98"], log: ["LOG", "#8a8f98"],
  html: ["<>", "#e34c26"], htm: ["<>", "#e34c26"], xml: ["<>", "#e37933"], svg: ["SVG", "#ffb13b"],
  css: ["#", "#563d7c"], scss: ["#", "#c6538c"], sass: ["#", "#c6538c"], less: ["#", "#1d365d"],
  py: ["PY", "#3572a5"], pyi: ["PY", "#3572a5"], ipynb: ["NB", "#da5b0b"],
  rs: ["RS", "#dea584"], go: ["GO", "#00add8"], java: ["JV", "#b07219"], kt: ["KT", "#a97bff"], kts: ["KT", "#a97bff"],
  c: ["C", "#555555"], h: ["H", "#a074c4"], cpp: ["C++", "#f34b7d"], cc: ["C++", "#f34b7d"], hpp: ["H++", "#f34b7d"],
  cs: ["C#", "#178600"], fs: ["F#", "#b845fc"], swift: ["SW", "#f05138"], dart: ["DT", "#00b4ab"],
  rb: ["RB", "#cc342d"], php: ["PHP", "#777bb4"], lua: ["LUA", "#000080"], r: ["R", "#198ce7"],
  sh: ["$", "#89e051"], bash: ["$", "#89e051"], zsh: ["$", "#89e051"], fish: ["$", "#89e051"], ps1: ["PS", "#012456"], bat: ["BAT", "#c1f12e"],
  yml: ["YML", "#cb171e"], yaml: ["YML", "#cb171e"], toml: ["TML", "#9c4221"], ini: ["INI", "#d1dbe0"], env: ["ENV", "#ecd53f"],
  sql: ["SQL", "#e38c00"], prisma: ["PR", "#5a67d8"], graphql: ["GQL", "#e10098"], gql: ["GQL", "#e10098"], proto: ["PB", "#7fa5d1"],
  vue: ["VUE", "#41b883"], svelte: ["SV", "#ff3e00"], astro: ["AST", "#ff5a03"],
  png: ["IMG", "#a074c4"], jpg: ["IMG", "#a074c4"], jpeg: ["IMG", "#a074c4"], gif: ["IMG", "#a074c4"], webp: ["IMG", "#a074c4"], ico: ["IMG", "#a074c4"],
  pdf: ["PDF", "#e5252a"], zip: ["ZIP", "#d4a017"], gz: ["ZIP", "#d4a017"], lock: ["LCK", "#8a8f98"],
  csv: ["CSV", "#89e051"], tf: ["TF", "#7b42bc"], dockerfile: ["DK", "#2496ed"],
};
const BY_NAME = {
  "dockerfile": ["DK", "#2496ed"], "docker-compose.yml": ["DK", "#2496ed"], "docker-compose.yaml": ["DK", "#2496ed"],
  "package.json": ["NPM", "#cb3837"], "package-lock.json": ["NPM", "#cb3837"], "pnpm-lock.yaml": ["PN", "#f69220"], "yarn.lock": ["YRN", "#2c8ebb"],
  ".gitignore": ["GIT", "#f05032"], ".gitattributes": ["GIT", "#f05032"], ".gitmodules": ["GIT", "#f05032"],
  "makefile": ["MK", "#427819"], "license": ["LIC", "#d0b343"], "readme.md": ["i", "#519aba"],
  "tsconfig.json": ["TS", "#3178c6"], ".env": ["ENV", "#ecd53f"], ".env.local": ["ENV", "#ecd53f"], ".npmrc": ["NPM", "#cb3837"],
  "cargo.toml": ["RS", "#dea584"], "go.mod": ["GO", "#00add8"], "requirements.txt": ["PY", "#3572a5"], "pyproject.toml": ["PY", "#3572a5"],
};

export function fileIcon(name) {
  const lower = name.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  if (lower.startsWith(".env")) return BY_NAME[".env"];
  if (lower.endsWith(".d.ts")) return BY_EXT["d.ts"];
  const ext = lower.includes(".") ? lower.split(".").pop() : "";
  return BY_EXT[ext] ?? ["•", "#8a8f98"];
}
