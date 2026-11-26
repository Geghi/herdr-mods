// herdr's editor colors code with syntect's built-in (Sublime default) grammars only:
// JS, Python, Rust, Go, C/C++, C#, Java, PHP, Ruby, HTML, CSS, JSON, YAML, Markdown, SQL, Shell,
// XML, Lua, Perl, R, Haskell, Scala, Clojure, Erlang, OCaml, D, Groovy, Batch, Makefile, Diff, LaTeX...
// Everything else is sent to the closest grammar it does have, by file name first, then extension.

const BY_NAME = {
  "dockerfile": ["bash", "Dockerfile"], "containerfile": ["bash", "Dockerfile"],
  "makefile": ["makefile", "Makefile"], "gnumakefile": ["makefile", "Makefile"],
  "gemfile": ["ruby", "Ruby"], "rakefile": ["ruby", "Ruby"], "podfile": ["ruby", "Ruby"], "vagrantfile": ["ruby", "Ruby"],
  "procfile": ["bash", "Procfile"], "justfile": ["makefile", "Justfile"],
  ".gitignore": ["bash", "Git ignore"], ".dockerignore": ["bash", "Docker ignore"], ".npmignore": ["bash", "npm ignore"],
  ".gitattributes": ["bash", "Git attributes"], ".gitmodules": ["bash", "Git config"], ".gitconfig": ["bash", "Git config"],
  ".editorconfig": ["bash", "EditorConfig"], ".npmrc": ["bash", "npm config"], ".nvmrc": ["bash", "nvm"],
  ".bashrc": ["bash", "Shell"], ".zshrc": ["bash", "Shell"], ".profile": ["bash", "Shell"], ".bash_profile": ["bash", "Shell"],
  ".prettierrc": ["json", "JSON"], ".eslintrc": ["json", "JSON"], ".babelrc": ["json", "JSON"],
  "cmakelists.txt": ["makefile", "CMake"], "requirements.txt": ["bash", "Requirements"],
};

const BY_EXT = {
  js: ["js", "JavaScript"], mjs: ["js", "JavaScript"], cjs: ["js", "JavaScript"], jsx: ["js", "JavaScript JSX"],
  ts: ["js", "TypeScript"], mts: ["js", "TypeScript"], cts: ["js", "TypeScript"], tsx: ["js", "TypeScript JSX"],
  json: ["json", "JSON"], jsonc: ["json", "JSON with comments"], json5: ["json", "JSON5"], webmanifest: ["json", "JSON"], ipynb: ["json", "Notebook"],
  html: ["html", "HTML"], htm: ["html", "HTML"], xhtml: ["html", "HTML"], vue: ["html", "Vue"], svelte: ["html", "Svelte"], astro: ["html", "Astro"],
  hbs: ["html", "Handlebars"], ejs: ["html", "EJS"], njk: ["html", "Nunjucks"], twig: ["html", "Twig"], erb: ["html", "ERB"],
  css: ["css", "CSS"], scss: ["css", "SCSS"], sass: ["css", "Sass"], less: ["css", "Less"], styl: ["css", "Stylus"], pcss: ["css", "PostCSS"],
  md: ["markdown", "Markdown"], markdown: ["markdown", "Markdown"], mdx: ["markdown", "MDX"], rst: ["rst", "reStructuredText"], tex: ["tex", "LaTeX"],
  yml: ["yaml", "YAML"], yaml: ["yaml", "YAML"], toml: ["yaml", "TOML"], lock: ["yaml", "Lockfile"],
  env: ["bash", "Environment"], ini: ["bash", "INI"], cfg: ["bash", "Config"], conf: ["bash", "Config"], properties: ["bash", "Properties"],
  sh: ["bash", "Shell"], bash: ["bash", "Shell"], zsh: ["bash", "Shell"], fish: ["bash", "Fish"], ps1: ["bash", "PowerShell"], psm1: ["bash", "PowerShell"],
  bat: ["bat", "Batch"], cmd: ["bat", "Batch"],
  py: ["python", "Python"], pyi: ["python", "Python"], pyw: ["python", "Python"],
  rs: ["rust", "Rust"], go: ["go", "Go"], rb: ["ruby", "Ruby"], php: ["php", "PHP"], lua: ["lua", "Lua"], pl: ["perl", "Perl"], pm: ["perl", "Perl"],
  java: ["java", "Java"], kt: ["java", "Kotlin"], kts: ["java", "Kotlin"], groovy: ["groovy", "Groovy"], gradle: ["groovy", "Gradle"], scala: ["scala", "Scala"],
  c: ["c", "C"], h: ["c", "C header"], cpp: ["cpp", "C++"], cc: ["cpp", "C++"], cxx: ["cpp", "C++"], hpp: ["cpp", "C++ header"], m: ["m", "Objective-C"],
  cs: ["cs", "C#"], fs: ["ocaml", "F#"], swift: ["rust", "Swift"], dart: ["java", "Dart"], zig: ["rust", "Zig"],
  r: ["r", "R"], hs: ["haskell", "Haskell"], ml: ["ocaml", "OCaml"], clj: ["clojure", "Clojure"], erl: ["erlang", "Erlang"], ex: ["ruby", "Elixir"], exs: ["ruby", "Elixir"],
  sql: ["sql", "SQL"], prisma: ["js", "Prisma"], graphql: ["js", "GraphQL"], gql: ["js", "GraphQL"], proto: ["c", "Protocol Buffers"],
  tf: ["ruby", "Terraform"], hcl: ["ruby", "HCL"], nix: ["js", "Nix"],
  xml: ["xml", "XML"], svg: ["xml", "SVG"], plist: ["xml", "Property list"], csproj: ["xml", "MSBuild"], xaml: ["xml", "XAML"],
  diff: ["diff", "Diff"], patch: ["diff", "Patch"], mk: ["makefile", "Makefile"], cmake: ["makefile", "CMake"],
};

// [syntax token for the editor, name for the status bar]
export function languageOf(path) {
  const name = path.split(/[\\/]/).pop().toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  if (name === ".env" || name.startsWith(".env.") || name.endsWith(".env")) return BY_EXT.env;
  if (name.startsWith("dockerfile") || name.endsWith(".dockerfile")) return BY_NAME.dockerfile;
  if (name.endsWith(".d.ts")) return ["js", "TypeScript declarations"];
  const ext = name.includes(".") ? name.split(".").pop() : "";
  return BY_EXT[ext] ?? [ext || "txt", ext ? ext.toUpperCase() : "Plain text"];
}
