# Workbench

A VS Code-style editor that opens as a tab: browse and edit files, review working changes, compare
your branch with main, and read the git history with diffs, all inside one Editor tab that follows
the space you are in, on this computer or on an ssh machine.

![Workbench](preview.png)

## What you see

- **Top bar:** four view icons on the left: Explorer, Changes, Compare, History. In the middle, the
  repo name and a branch pill (`⎇ branch ▸`) that opens the branch switcher. On the right, a toggle
  for the sidebar.
- **Sidebar** (default 300 px, drag its right edge to resize, drag below 120 px to hide it, double-click
  the edge to reset):
  - **Explorer:** a lazy file tree of the space's folder. Each file has a small colored badge for its
    type (TS, JS, PY, MD, JSON…).
  - **Changes:** a commit message box, a Commit button (staged files only if any are staged, else
    everything), and a ↓ Pull button (fast-forward only). Below them, STAGED CHANGES and CHANGES
    sections, shown as a folder tree or a flat list. Each row shows a status letter (M/A/D/R/U)
    and +/− counts. Hovering a row shows open / discard / stage-or-unstage buttons. A ⋯ menu adds
    "Add to .gitignore", "Add folder to .gitignore", "Ignore all *.ext files", "Copy path" and
    "Copy full path". Discarding asks for confirmation in a red banner.
  - **Compare:** two branch pickers, base (defaults to main/master) and target (defaults to the
    current branch), with a swap button and an "Include uncommitted changes" checkbox. Below them, the tree of
    files changed since the merge base, with ahead/behind counts.
  - **History:** branch scope (current branch or all), then the commit list.
- **Main area:** document tabs (files, diffs, the History graph) with an unsaved dot. Files open in a
  code editor with syntax colors picked from the file name. Diffs have a unified/split switch, with
  red and green line backgrounds and line numbers on both sides. History shows one row per commit:
  graph lanes, ref badges, subject, author and relative time. Clicking a commit lists its changed
  files as a tree, and each one opens as a diff.
- **Status bar:** `Local` or `SSH: <machine>`, branch and "N changed"/"clean", the last message,
  then for an open file its line count, CRLF/LF, UTF-8, language and a Save/Saved button.
- Under 1050 px the top bar and sidebar shrink to a compact form.

## How it behaves

- Opens with **Ctrl+Shift+Y** (or "Open editor" in the command palette). Pressing it again switches
  to the space's existing Editor tab instead of making another one.
- The root is the space's folder (the first terminal's working directory). On a space on an ssh
  machine, files are read with `readTextFile(path, {on})`, git runs through `exec(..., {on})`, and saves go
  through `exec` as chunked base64 (`sh`, or PowerShell when the remote has no `sh`), size-checked
  before the file is replaced.
- Keys while the Editor has focus: Ctrl+S save, Ctrl+W or Ctrl+F4 close the open file (not the
  tab), Ctrl+B toggle the sidebar. Showing the tab focuses the active document automatically, so
  Ctrl+F4 works right after opening.
- Local saves check the file on disk first and show a conflict banner if it changed.
- Branch switcher: filter field, LOCAL and REMOTE lists, "create from current" field. A remote
  branch opens as a local tracking branch. A branch checked out in another worktree, or
  uncommitted changes that would be overwritten, get a plain explanation instead of git's error.
- Open files that were not edited reload after a branch switch or a pull.
- Sidebar width, view, tree/list mode and open files are kept per space.
- `tab.new` props: `open` (a path or a list of paths, relative to the space folder) opens files, and
  `view` (`explorer`, `changes`, `compare`, `graph`) picks the starting view.
- Other mods can open a file in it: `setShared("code.open", {space, root, on, path, n: Date.now()})`, then select or
  create the Editor tab (see the files-to-editor mod).

## Built from

- `mods/code/main.js` (the `View`), `git.js` (git commands, diff rows, graph lanes, file trees),
  `icons.js` (file-type badges), `langs.js` (file name to syntax), plus lucide-style SVG icons.
- `mod.json`: `"place": "none"`, `"focusable": true`, palette entries "Open editor" (`tab.new` with
  `mod: "code"`) and "Git: Pull" (`code.pull`).
- `keys.json`: the global Ctrl+Shift+Y and the `mod:code` section.
- gpui-base: `Editor`/`EditorState`, `Input`/`InputState`, `v_virtual_list` for long lists and the
  graph.

## Watch out

- The mod runs programs: `git` everywhere, `sh` or `powershell` for folder listing and remote saves.
- Syntax colors come from herdr's built-in grammars (Sublime defaults). TypeScript, TOML, .env and
  Dockerfile have no grammar there, so they use the closest one (JS, YAML, shell).
- Rows in a `v_virtual_list` can't use `on_click`; use the list's `on_item_click`.
- Write `mod.json` before `main.js` when installing, or herdr docks the mod into the layout.
- Pull is `git pull --ff-only`; diverged branches are refused with a message, never merged.

## Done when

- Ctrl+Shift+Y opens the Editor at the space's folder; a second press returns to the same tab.
- Editing a file and pressing Ctrl+S saves it, also on an ssh machine.
- Changes lists staged and unstaged files; stage, unstage, discard and .gitignore work.
- Compare shows the files changed against main; History shows commits and their diffs.
- Ctrl+F4 closes the open file, not the Editor tab.
