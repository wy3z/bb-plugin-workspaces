# Workspaces

Paseo-style workspaces for BB. Every thread is a workspace, and the agents in
it show as tabs in the thread header. Click a tab to switch, drag to reorder,
and close one with **×** (that archives the thread).

The workspace name takes the place of the thread title. Double-click it to rename. A
workspace with one thread shows just its name and **+**.

## The + menu

| Item | What it does |
| --- | --- |
| **Agent** | Opens a **New agent** tab with BB's composer, set to this workspace's directory. Sending it turns the tab into a real thread in the workspace. An unsent draft stays as a tab until you close it. |
| **Terminal** | Opens a shell in BB's terminal panel. |
| **Browser** | Asks for a URL and opens it in BB's browser, in the thread's main pane where the build supports it. |
| **Terminal profiles** | Opens a terminal running a command, such as `claude` or `codex`. |

Edit the profiles under **Settings → Plugins → Workspaces**, one per line as
`Name=command`.

## What counts as one workspace

A thread joins a workspace by the first rule that applies:

1. It was added with **+ → Agent**, or moved with a command. This is stored in
   the plugin's thread metadata, key `workspaceId`.
2. It is a top-level thread sharing a worktree with others.
3. Otherwise it is a workspace of one.

Delegated and forked threads stay out of the tabs, because the sidebar already
nests them under their parent. Project checkouts are not grouped by
environment, because one checkout can hold hundreds of unrelated threads.

Other plugins can read membership with
`threads.getPluginMetadata({ threadId, pluginId: "workspaces" })`. The keys
are `workspaceId`, `workspaceName` and `tabOrder`. After it writes them, the
plugin fires a `bb-workspaces:changed` event on `window`.
[Cursor Sidebar](https://github.com/wy3z/bb-plugin-cursor-sidebar) uses this
to nest a workspace's threads under its first thread.

## Commands

| Command | Default shortcut |
| --- | --- |
| Workspace: add an agent | Mod+Shift+A |
| Workspace: open a terminal | Mod+Alt+T |
| Workspace: open a browser | Mod+Shift+B |
| Workspace: next tab / previous tab | Mod+Alt+] / Mod+Alt+[ |
| Workspace: jump to tab 1–9 | Mod+Alt+1 … Mod+Alt+9 |
| Workspace: move this thread to its own workspace | none |
| Workspace: reset this thread's workspace | none |

Right-click a tab for BB's usual thread menu. Middle-click closes it.

## BB builds with a main pane

BB builds with a thread main pane (`wy3z/bb` `feat/main-pane-tabs`) draw a tab
row under the header once a panel tab has moved beside the chat. The agent tabs
join that row in place of its **Chat** pill, and **+** moves to the header.
Clicking the current agent's tab brings the chat back from a moved panel tab.
On stock BB, or before any tab has moved, the tabs stay in the header.

## Limits

- BB has no slot for tabs in the thread header. The plugin places them in the
  header's title area itself. If a BB update changes that layout, the tabs fall
  back to a row of their own under the header.
- Terminals open in BB's side panel, not as tabs. Browsers do too on builds
  without a main pane.
- Each tab is its own thread, so switching tabs changes the page.

## Installation

```sh
bb plugin install git:https://github.com/wy3z/bb-plugin-workspaces.git
```

## Development

```sh
npm install
npm run check
bb plugin install . --yes
```

## License

[MIT](LICENSE)
