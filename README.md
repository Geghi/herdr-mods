# herdr mods

Mods for [herdr-app](https://herdr.dev). Each folder is one mod, with a `RECIPE.md` and a `preview.png`.

| Folder | Mod | What it does |
| --- | --- | --- |
| [workbench](workbench) | `code` | VS Code-style editor tab: Explorer, Changes (stage, discard, .gitignore), Compare with main, History graph, diffs, branch switcher, pull. Works over ssh. |
| [agents-by-repo](agents-by-repo) | `my-agents` | Agents list grouped by machine and main repository, with worktree and branch on each row. |
| [files-to-editor](files-to-editor) | `my-files` | Files panel that opens files in the Workbench editor. Needs `workbench`. |

## Install

Tell your agent:

> Read ~/.config/herdr-app/AGENTS.md, then add this mod: herdr.dev/mods/&lt;owner&gt;/workbench

## Keeping several machines in sync

`sync/` has the scripts used to keep these mods identical on a Windows and a Linux machine.
Clone the repo on each machine and run `sync/herdr-sync.ps1` or `sync/herdr-sync.sh` every few
minutes. They copy the live mods from `~/.config/herdr-app/mods` into the repo, commit,
`pull --rebase` and push, then copy the result back so herdr hot-reloads it. (Linking the folders
instead doesn't work: herdr's hot reload doesn't see changes behind a junction or symlink.)
On a conflict they stop and write `sync/last-error.log` instead of pushing.

The screenshots in each folder are taken from this repository.
