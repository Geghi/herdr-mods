// Agents in grouped or priority views; parents take their most urgent sub-agent's place.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, focused, spaces, run, exec, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout } from "herdr";

// Where a space is: its first terminal's live folder (as the Spaces sidebar reads it), else its folder.
function spacePlace(sp, ps) {
  for (const tab of sp.tabs) {
    const p = ps.find((p) => p.tab === tab.id && p.terminal && p.cwd);
    if (p) return p.cwd;
  }
  return sp.folder || "";
}
const baseName = (path) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
// A repo's name from its git folder (the folder holding .git, or a bare repo's own name).
const repoName = (common) => {
  if (/[\\/]\.git$/.test(common)) return baseName(common.slice(0, -5));
  const own = baseName(common);
  return own === ".bare" ? baseName(common.slice(0, -own.length - 1)) : own.replace(/\.git$/, "");
};

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

// Drops what an agent puts before its title: a status glyph or spinner and the separator
// after it ("✦  Working", "⠋ - Thinking"), and Codex's blinking "[ ! ] " / "[ . ] " mark.
// Stops at an opening bracket or quote, so a title that starts with one ("[web] login") keeps it,
// and at an emoji ("🔴 login", "❤️ deploy"), except for known status marks.
const clean = (s) => (s ?? "").replace(/^(?:\[ [!.] \] |[✋⏳]\uFE0F?(?=\s)|(?!(?:\p{Emoji}\uFE0F|[#*]\u20E3))[^\p{L}\p{N}\p{Ps}\p{Pi}\p{Emoji_Presentation}])+/u, "").trim();

function leadPanes(all) {
  const leads = new Map();
  for (const p of all) {
    if (!p.terminal) continue;
    const current = leads.get(p.tab);
    // First agent, else first focused terminal, else first terminal in the tab.
    if (!current || (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))) leads.set(p.tab, p);
  }
  return leads;
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  // clean() would strip a path's leading ~ or /: test the title with only its status glyph gone.
  const path = /^[~/]|^[A-Za-z]:\\/.test((l?.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== (l?.terminal ?? l?.address) && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// The last two parts of a folder ("acme/web"); a home folder reads "~".
function shortFolder(path) {
  if (!path) return "";
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  if (parts.length >= 2 && /^(home|Users)$/i.test(parts[parts.length - 2])) return "~";
  return parts.slice(-2).join("/");
}
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
// A kept sub-agent (one with a pane) is in agents() too: it keeps its own status, done included.
const kidStatus = (k, listed) => {
  if (listed.has(k.address)) return listed.get(k.address);
  const s = k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "priority", label: "Most urgent first", icon: "clock" },
  { id: "grouped", label: "Space order", icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class Agents extends View {
  init(_props, cx) {
    if (props()?.sortMenu) return;
    this.folded = new Set();
    // Each agent's last state and when it changed (ms), kept across restarts.
    try { this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}"); } catch { this.changed = {}; }
    if (!this.changed || typeof this.changed !== "object" || Array.isArray(this.changed)) this.changed = {};
    try { this.pendingPins = JSON.parse(localStorage.getItem("pins") ?? "[]"); } catch { this.pendingPins = []; }
    if (!Array.isArray(this.pendingPins)) this.pendingPins = [];
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    this.migratingPins = new Set();
    // Each place's repo: { repo, linked } (a linked worktree belongs to its main checkout's space).
    this.repos = {}; this.asked = {};
    cx.timer.every(30000, (cx) => cx.notify());
    cx.timer.every(20000, (cx) => { this.asked = {}; cx.notify(); });
  }

  // The space a group is named after: the repo's main checkout, else the space itself.
  groupSpace(key) {
    if (key.startsWith("repo:")) return this.family?.mainOf.get(key.slice(5)) ?? null;
    return key.slice(3);
  }

  // Asks git once per place (refreshed every 20 s) which repo it belongs to.
  repoOf(key, cx) {
    if (key in this.repos && this.asked[key]) return this.repos[key];
    if (!this.asked[key]) {
      this.asked[key] = true;
      const [on, cwd] = JSON.parse(key);
      if (cwd) cx.spawn(async (cx) => {
        try {
          const [top, common] = await Promise.all([
            exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd, on }),
            exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on }),
          ]);
          const was = JSON.stringify(this.repos[key] ?? null);
          if (top.code === 0 && common.code === 0) {
            const t = top.stdout.trim().replaceAll("\\", "/"), c = common.stdout.trim().replaceAll("\\", "/");
            this.repos[key] = { repo: JSON.stringify([on, c]), name: repoName(c), linked: c !== `${t}/.git` };
          } else this.repos[key] = null;
          if (JSON.stringify(this.repos[key]) !== was) cx.notify();
        } catch { /* machine away: keep what we had */ }
      });
    }
    return this.repos[key] ?? null;
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Keep offline pins until their terminal returns, and keep each pending until
  // core echoes the label so a failed write doesn't erase the old pin.
  migratePins(all) {
    const listed = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const pending = this.pendingPins.filter((address) => {
      const terminal = listed.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["herdr.pinned"]) return false;
      if (!this.migratingPins.has(address)) {
        this.migratingPins.add(address);
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });
    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) localStorage.setItem("pins", JSON.stringify(pending));
    else localStorage.removeItem("pins");
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  rank(a) {
    return RANK[a.status] ?? 0;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("agents.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  subRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(22)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => (this.listed.has(k.address) ? run("pane.focus", { terminal: k.address }) : this.peek(k.address)))
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, { status: st }, compact));
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    // Idle: a ring; done: a dot.
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  render(cx) {
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    const collapsed = narrow();
    const sort = sortOf();
    let list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    this.migratePins(all);
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    // A kept sub-agent (one with a pane) is in agents() too: where a tree shows
    // it, it gets no row of its own, unless it's pinned.
    const nested = new Set(collapsed ? [] : list.flatMap((a) => this.tree(all, a.address).map((s) => s.t.address)));
    list = list.filter((a) => a.pinned || !nested.has(a.address));
    const tabCounts = new Map();
    for (const a of list) tabCounts.set(a.tab, (tabCounts.get(a.tab) ?? 0) + 1);
    const byPriority = sort.id === "priority";
    // A helper's done is its own row's news: it doesn't pull a working parent out of Working.
    const kidRank = (k) => { const s = kidStatus(k, this.listed); return RANK[s === "done" ? "idle" : s] ?? 0; };
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => kidRank(s.t)))]));
    const rankOf = (a) => urgency.get(a.address);
    const spaceList = spaces(), spaceIndex = new Map(spaceList.map((sp, i) => [sp.id, i]));
    const pinned = list.filter((a) => a.pinned);
    let rest = list.filter((a) => !a.pinned);
    // Always one group per space. Most urgent first: urgent spaces on top, urgent agents first inside.
    // Group by the main project space: a worktree space's agents go under the space of its
    // repo's main checkout (my-app, not fix/some-bug). Spaces outside git stay on their own.
    const ps = panes();
    const info = new Map(spaceList.map((sp) => [sp.id, this.repoOf(JSON.stringify([sp.machine ?? null, spacePlace(sp, ps)]), cx)]));
    const mainOf = new Map();
    for (const sp of spaceList) { const g = info.get(sp.id); if (g && !g.linked && !mainOf.has(g.repo)) mainOf.set(g.repo, sp.id); }
    const familyOf = (spaceId) => { const g = info.get(spaceId); return g ? `repo:${g.repo}` : `sp:${spaceId}`; };
    this.family = { info, mainOf, familyOf };
    const bySpace = new Map();
    for (const a of rest) { const k = familyOf(a.space); if (!bySpace.has(k)) bySpace.set(k, []); bySpace.get(k).push(a); }
    const urgentFirst = (x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq;
    const spaceGroups = [...bySpace.entries()].map(([id, members]) => ({ id, members: byPriority ? [...members].sort(urgentFirst) : members }));
    const spaceOfId = new Map(spaceList.map((sp) => [sp.id, sp]));
    const machineOf = (g) => (spaceOfId.get(this.groupSpace(g.id)) ?? spaceOfId.get(g.members[0]?.space))?.machine ?? null;
    const machineRank = (m) => (m === null ? "0" : "1" + m);
    if (byPriority) spaceGroups.sort((x, y) => machineRank(machineOf(x)).localeCompare(machineRank(machineOf(y))) || urgentFirst(x.members[0], y.members[0]));
    else {
      const at = (g) => Math.min(...g.members.map((a) => spaceIndex.get(a.space) ?? 1e9), spaceIndex.get(this.groupSpace(g.id)) ?? 1e9);
      spaceGroups.sort((x, y) => machineRank(machineOf(x)).localeCompare(machineRank(machineOf(y))) || at(x) - at(y));
    }
    rest = spaceGroups.flatMap((g) => g.members);
    list = [...pinned, ...rest];
    // Alt+Up/Down follow exactly what the list shows.
    setAgentOrder(list.map((a) => a.address));

    // Tree guides: one thin vertical line per level in front of a row.
    const nest = (depth, el) => depth <= 0 ? el : h_flex().flex_none().items_stretch()
      .children(Array.from({ length: depth }, () => div().w(12).flex_none().flex().justify_center()
        .child(div().w(1).h_full().bg(t.border))))
      .child(el.flex_1().min_w(0));
    const withKids = (a, i, depth = 0, plain = false) => {
      const subs = collapsed ? [] : this.tree(all, a.address);
      const r = nest(depth, row(a, i, subs, plain));
      if (this.folded.has(a.address)) return [r];
      return [r, ...subs.map((s) => nest(depth, this.subRow(t, s, shown, byPriority)))];
    };

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    // A row reads "space \u00b7 detail": the detail is a tab someone named or the
    // agent's own title, never an automatic tab number unless two rows would
    // otherwise read the same.
    // Read the pane snapshot once: every host read copies the whole list into JS.
    const paneList = panes();
    const leads = leadPanes(paneList);
    const paneById = new Map(paneList.map((p) => [p.pane, p]));
    const spaceById = new Map(spaceList.map((sp) => [sp.id, sp]));
    const tabs = new Map(spaces().flatMap(s => s.tabs).map(tab => [tab.id, tab]));
    const labels = new Map(list.map(a => {
      const tab = tabs.get(a.tab);
      const many = tabCounts.get(a.tab) > 1;
      return [a.address, tab ? title(many ? { ...tab, named: false } : tab, many ? a : leads.get(a.tab)) : (a.title || a.program?.name || "")];
    }));
    const label = (a) => labels.get(a.address);
    const detail = new Map(list.map(a => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }

    const row = (a, i, subs = [], plain = false) => {
      const pic = icon(a.program, 14, t.foreground);
      const more = detail.get(a.address);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .mx(6)
          .px(2)
          .rounded(6)
          .flex_none()
          .items_center()
          .gap(4)
          .when(a.focused, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(a.focused ? t.foreground : t.muted).child(String(i + 1)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true)));
      }
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const isPinned = a.pinned;
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          run("terminal.pin", { terminal: a.address, pinned: !isPinned });
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      // One line: the agent's branch when it is on one other than main/master, else its tab or title.
      // The rest (title, space, folder) is in the tooltip.
      const pane = paneById.get(a.pane), sp = spaceById.get(a.space);
      const raw = label(a);
      const title = /^\d+$/.test(raw) ? `${a.program?.name || "Agent"} · tab ${raw}` : raw || a.program?.name || a.address;
      const branch = pane?.branch || sp?.branch || "";
      // In the tree the branch is on the header above: the row says the tab or the agent's title.
      const onBranch = !plain && Boolean(branch) && !/^(main|master)$/.test(branch);
      const name = onBranch ? branch : title;
      const folder = shortFolder(pane?.cwd || sp?.folder);
      const where = [onBranch ? title : "", a.space_name || "", branch ? `⎇ ${branch}` : "", folder].filter(Boolean).join("  ·  ");
      return h_flex()
        .id(`ag-${a.address}`)
        .tooltip(where)
        .px(8)
        .h(24)
        .flex_none()
        .rounded(8)
        .items_center()
        .gap(7)
        .when(a.focused, (el) => el.bg(t.selected))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .when(Boolean(pic), el => el.child(div().id(`agent-fold-${a.address}`)
          .when(subs.length > 0, el => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
            cx.notify();
          })).child(pic)))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .when(onBranch, el => el.child(svg("mods/workspace-chrome/branch.svg").size(12).flex_none().text_color(t.dim)))
          .child(div().min_w(0).truncate().text_size(12.5).text_color(idle ? t.muted : t.foreground).child(name)))
        .when(subs.length > 0, el => el.child(fold(a, subs)))
        .when(this.hovered === a.address, el => el.child(pin))
        .when(this.hovered !== a.address && Boolean(when), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when))))
        .child(this.status(t, a, false));
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    for (const g of spaceGroups) {
      const main = spaceById.get(this.groupSpace(g.id)) ?? spaceById.get(g.members[0]?.space);
      const repo = g.id.startsWith("repo:") ? this.family.info.get(g.members[0]?.space)?.name : null;
      const members = new Set(g.members.map((a) => a.space));
      groups.push({ id: `sp-${g.id}`, space: main, mainId: main?.id, label: main?.name || repo || g.members[0]?.space_name || "",
        active: [...members].some((id) => spaceById.get(id)?.active) || Boolean(main?.active), status: null, members: g.members });
    }

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    // A space's header: folds it; shows the space, its branch and machine, the active one marked.
    const header = (g, multi = false) => {
      const open = !this.folded.has(g.id);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      const sp = g.space, active = Boolean(g.active ?? sp?.active), machine = sp?.machine ?? null;
      const branch = !multi && sp?.branch && sp.branch !== g.label ? sp.branch : null;
      return h_flex()
        .id(g.id)
        .mt(3)
        .px(6)
        .h(23)
        .flex_none()
        .gap(6)
        .items_center()
        .rounded(6)
        .text_size(12.5)
        .font_semibold()
        .cursor_pointer()
        .when(active, (el) => el.bg(t.raised))
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(10).flex_none().text_color(t.dim))
        .child(svg("mods/workspace-chrome/folder.svg").size(13).flex_none().text_color(active ? t.accent : t.muted))
        .child(div().min_w(0).truncate().text_color(t.foreground).child(g.label))
        .child(div().min_w(0).flex_1().truncate().font_normal().text_size(11.5).text_color(t.dim).child(branch ? `⎇ ${branch}` : ""))
        .child(div().flex_none().text_color(t.dim).font_normal().child(String(g.members.length)))
        .when(!open && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)));
    };
    // Machine > project > agents. A machine header folds everything on that machine.
    const machineHeader = (m, gs) => {
      const id = `machine-${m ?? "local"}`, open = !this.folded.has(id);
      const count = gs.reduce((n, g) => n + g.members.length, 0);
      const top = gs.flatMap((g) => g.members).reduce((x, a) => ((RANK[a.status] ?? 0) > (RANK[x] ?? 0) ? a.status : x), null);
      return h_flex().id(id).mt(4).px(6).h(19).flex_none().gap(6).items_center().rounded(6).cursor_pointer()
        .text_size(10).font_weight(700).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { open ? this.folded.add(id) : this.folded.delete(id); cx.notify(); })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(10).flex_none())
        .child(div().w(6).h(6).flex_none().rounded(3).bg(m === null ? t.ansi2 : t.ansi4))
        .child(div().min_w(0).flex_1().truncate().child((m === null ? "THIS COMPUTER" : m).toUpperCase()))
        .child(div().flex_none().font_normal().child(String(count)))
        .when(!open && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)));
    };
    const byMachine = [];
    for (const g of groups) {
      const m = g.id === "pinned" ? "pinned" : (g.space?.machine ?? null);
      const last = byMachine[byMachine.length - 1];
      if (last && last.m === m) last.gs.push(g); else byMachine.push({ m, gs: [g] });
    }
    const topOf = (ms) => ms.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
    // A level under a project (a worktree/space, a tab with several agents): folds what's under it.
    const subHeader = (id, iconName, label, tip, ms, active, small) => {
      const open = !this.folded.has(id), top = topOf(ms);
      return h_flex().id(id).h(small ? 19 : 21).mt(small ? 0 : 1).px(6).flex_none().gap(6).items_center().rounded(6).cursor_pointer()
        .text_size(small ? 11 : 12).when(!small, (el) => el.font_medium())
        .when(active, (el) => el.bg(t.raised)).hover((s) => s.bg(t.hover))
        .when(Boolean(tip), (el) => el.tooltip(tip))
        .on_click((_e, cx) => { open ? this.folded.add(id) : this.folded.delete(id); cx.notify(); })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(9).flex_none().text_color(t.dim))
        .child(svg(`mods/workspace-chrome/${iconName}.svg`).size(small ? 11 : 12).flex_none().text_color(active ? t.accent : t.dim))
        .child(div().min_w(0).flex_1().truncate().text_color(small ? t.dim : active ? t.foreground : t.muted).child(label))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(String(ms.length)))
        .when(!open && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)));
    };
    // Agents of one space: a tab with several agents gets its own level, a lone agent sits directly.
    const tabRows = (ms, depth) => {
      const byTab = new Map();
      for (const a of ms) { if (!byTab.has(a.tab)) byTab.set(a.tab, []); byTab.get(a.tab).push(a); }
      return [...byTab.entries()].flatMap(([tabId, tms]) => {
        if (tms.length < 2) return tms.flatMap((a) => withKids(a, 0, depth, true));
        const id = `tab-${tabId}`, tab = tabs.get(tabId);
        const name = !tab ? "Tab" : /^\d+$/.test(tab.name) ? `Tab ${tab.name}` : tab.name;
        return [nest(depth, subHeader(id, "terminal", name, null, tms, false, true)),
          ...(this.folded.has(id) ? [] : tms.flatMap((a) => withKids(a, 0, depth + 1, true)))];
      });
    };
    // Project > space (main checkout or a worktree, only when there are several) > tab > agent.
    // b: the levels above the project (1 under a machine header, 0 when there is only one machine).
    const projectRows = (g, b = 0) => {
      if (g.id === "pinned") return [header(g), ...(this.folded.has(g.id) ? [] : g.members.flatMap((a) => withKids(a, 0, 1)))];
      const bySp = new Map();
      for (const a of g.members) { if (!bySp.has(a.space)) bySp.set(a.space, []); bySp.get(a.space).push(a); }
      const multi = bySp.size > 1 || (bySp.size === 1 && g.mainId && !bySp.has(g.mainId));
      const out = [nest(b, header(g, multi))];
      if (this.folded.has(g.id)) return out;
      if (!multi) return [...out, ...tabRows(g.members, b + 1)];
      for (const [spId, ms] of bySp) {
        const sp = spaceById.get(spId), id = `space-${spId}`;
        const linked = Boolean(this.family.info.get(spId)?.linked);
        const label = sp?.branch || sp?.name || ms[0]?.space_name || "";
        const tip = [sp?.name, linked ? "worktree" : "main checkout", shortFolder(sp?.folder)].filter(Boolean).join("  ·  ");
        out.push(nest(b + 1, subHeader(id, sp?.branch ? "branch" : "folder", label, tip, ms, Boolean(sp?.active), false)));
        if (!this.folded.has(id)) out.push(...tabRows(ms, b + 2));
      }
      return out;
    };
    const oneMachine = new Set(byMachine.filter((x) => x.m !== "pinned").map((x) => x.m)).size <= 1;
    const rows = collapsed
      ? list.flatMap((a, i) => withKids(a, i))
      // One machine only: no machine header and one level less.
      : byMachine.flatMap(({ m, gs }) => m === "pinned" || oneMachine ? gs.flatMap((g) => projectRows(g))
        : [machineHeader(m, gs), ...(this.folded.has(`machine-${m ?? "local"}`) ? [] : gs.flatMap((g) => projectRows(g, 1)))]);

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .px(16)
            .h(41)
            .pt(14)
            .pb(5)
            .flex_none()
            .items_center()
            .justify_between()
            .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Agents"))
            .child(
              div()
                .id("ag-sort")
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => openOverlay({ mod: "my-agents", kind: "popup", width: 200, height: 140, props: { sortMenu: true } }))
                .tooltip(`Sort agents: ${sort.label}`)
                .child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(14)),
            ),
        ),
      )
      .when(list.length === 0 && !collapsed, (el) =>
        el.child(div().px(12).text_size(12).text_color(t.dim).child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 0 : 8).overflow_y_scrollbar().mode("always").children(rows))
      .when(collapsed, (el) =>
        el.child(
          h_flex()
            .h(28)
            .items_center()
            .justify_center()
            .child(
              div()
                .id("collapse")
                .text_size(13)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(toggleSidebar)
                .child("»"),
            ),
        ),
      );
  }
}
