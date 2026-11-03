import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_NewThreadComposer as NewThreadComposer,
  experimental_ThreadActionsContextMenu as ThreadActionsContextMenu,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_useSidebarThreads as useSidebarThreads,
  ThreadTitle,
  useBbNavigate,
  useSdk,
  useSettings,
  useSidebarThreadRowStatus,
  type PluginBrowserBbSdk,
  type PluginSidebarThread,
  type PluginThreadActionTarget,
} from "@get-bb/plugin-sdk/app";
import {
  TAB_ORDER_KEY,
  WORKSPACE_ID_KEY,
  WORKSPACE_NAME_KEY,
  adjacentTab,
  orderBetween,
  readThreadMeta,
  resolveWorkspaceIds,
  selfWorkspaceId,
  workspaceTabs,
  type ThreadMeta,
  type WorkspaceThread,
} from "./lib/workspaces.js";
import { parseTerminalProfiles, type TerminalProfile } from "./lib/profiles.js";
import {
  registerThreadHeaderAction,
  type ThreadHeaderActionProps,
} from "./lib/header-slot.js";
import "./app.css";

const COMMAND_EVENT = "bb-workspaces:command";
/** Fired after this plugin writes thread metadata, for other plugins (cursor-sidebar). */
const CHANGED_EVENT = "bb-workspaces:changed";
const METADATA_CHUNK = 100;
const FOCUS_REFRESH_MS = 30_000;
const DRAFT_ATTRIBUTE = "data-bbw-draft";
const DRAFTS_STORAGE_KEY = "bb-workspaces.drafts.v1";
const JUMP_TABS = 9;

type CommandAction =
  | "next"
  | "previous"
  | "new-agent"
  | "new-terminal"
  | "new-browser"
  | "detach"
  | "rejoin"
  | `tab-${number}`;

// ---------------------------------------------------------------------------
// Shared state. A split layout mounts one tab row per pane, so membership and
// open drafts live at module level and every row subscribes.

const meta = new Map<string, ThreadMeta>();
const fetched = new Set<string>();
const inflight = new Set<string>();
const drafts = new Set<string>(readStoredDrafts());
const listeners = new Set<() => void>();
let version = 0;
let lastFocusRefresh = Date.now();

function emit() {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getVersion() {
  return version;
}

function readStoredDrafts(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(DRAFTS_STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function setDraftOpen(workspaceId: string, open: boolean) {
  if (open === drafts.has(workspaceId)) return;
  if (open) drafts.add(workspaceId);
  else drafts.delete(workspaceId);
  localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify([...drafts]));
  emit();
}

async function syncMetadata(sdk: PluginBrowserBbSdk, threadIds: readonly string[]) {
  const missing = threadIds.filter((id) => !fetched.has(id) && !inflight.has(id));
  for (let start = 0; start < missing.length; start += METADATA_CHUNK) {
    const chunk = missing.slice(start, start + METADATA_CHUNK);
    for (const id of chunk) inflight.add(id);
    try {
      const result = await sdk.threads.experimental_listPluginMetadata({ threadIds: chunk });
      for (const id of chunk) {
        fetched.add(id);
        meta.delete(id);
      }
      for (const entry of result.threads) meta.set(entry.threadId, readThreadMeta(entry.metadata));
      emit();
    } catch (error) {
      console.warn("[workspaces] could not read thread metadata", error);
    } finally {
      for (const id of chunk) inflight.delete(id);
    }
  }
}

type MetaPatch = { [K in keyof ThreadMeta]?: ThreadMeta[K] | null };

const META_KEYS: Record<keyof ThreadMeta, string> = {
  workspaceId: WORKSPACE_ID_KEY,
  tabOrder: TAB_ORDER_KEY,
  workspaceName: WORKSPACE_NAME_KEY,
};

async function updateMeta(sdk: PluginBrowserBbSdk, threadId: string, patch: MetaPatch) {
  const next: ThreadMeta = { ...meta.get(threadId) };
  const set: Record<string, string | number> = {};
  const remove: string[] = [];
  for (const field of Object.keys(patch) as (keyof ThreadMeta)[]) {
    const value = patch[field];
    if (value === null || value === undefined) {
      delete next[field];
      remove.push(META_KEYS[field]);
    } else {
      (next as Record<string, unknown>)[field] = value;
      set[META_KEYS[field]] = value;
    }
  }
  meta.set(threadId, next);
  fetched.add(threadId);
  emit();
  await sdk.threads.updatePluginMetadata({
    threadId,
    ...(Object.keys(set).length > 0 ? { set } : {}),
    ...(remove.length > 0 ? { remove } : {}),
  });
  window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
}

// Another window or the CLI may have changed metadata; re-read on focus.
window.addEventListener("focus", () => {
  if (Date.now() - lastFocusRefresh < FOCUS_REFRESH_MS) return;
  lastFocusRefresh = Date.now();
  fetched.clear();
  emit();
});

// ---------------------------------------------------------------------------
// Workspace model

function toActionTarget(thread: PluginSidebarThread): PluginThreadActionTarget {
  return {
    id: thread.id,
    projectId: thread.projectId,
    parentThreadId: thread.parentThreadId,
    parentNotifications: thread.parentNotifications,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt,
    sectionId: thread.sectionId,
    isUnread: thread.isUnread,
    status: thread.status,
    environment: thread.environment?.id
      ? { id: thread.environment.id, path: thread.environment.path }
      : null,
  };
}

function tabOrderOf(thread: PluginSidebarThread) {
  return meta.get(thread.id)?.tabOrder ?? thread.createdAt;
}

function useWorkspace(threadId: string) {
  const { threads } = useSidebarThreads();
  const sdk = useSdk();
  const metaVersion = useSyncExternalStore(subscribe, getVersion);

  useEffect(() => {
    void syncMetadata(
      sdk,
      threads.map((thread) => thread.id),
    );
  }, [sdk, threads, metaVersion]);

  return useMemo(() => {
    const live = threads.filter((thread) => !thread.isArchived);
    const byId = new Map(live.map((thread) => [thread.id, thread]));
    const model: WorkspaceThread[] = live.map((thread) => ({
      id: thread.id,
      parentThreadId: thread.parentThreadId,
      environmentId: thread.environment?.id ?? null,
      isWorktree: thread.environment?.isWorktree === true,
      order: tabOrderOf(thread),
    }));
    const explicit = new Map<string, string>();
    for (const [id, entry] of meta) if (entry.workspaceId) explicit.set(id, entry.workspaceId);
    const resolved = resolveWorkspaceIds(model, explicit);
    const tabs = workspaceTabs(threadId, model, resolved)
      .map((id) => byId.get(id))
      .filter((thread): thread is PluginSidebarThread => thread !== undefined);
    const workspaceId = resolved.get(threadId) ?? null;
    return {
      workspaceId,
      tabs,
      current: byId.get(threadId) ?? null,
      name: tabs.map((thread) => meta.get(thread.id)?.workspaceName).find(Boolean) ?? null,
      isExplicit: explicit.has(threadId),
      draftOpen: workspaceId !== null && drafts.has(workspaceId),
    };
    // metaVersion stands in for the mutable module state read above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, threadId, metaVersion]);
}

// ---------------------------------------------------------------------------
// Layout: the tabs share the pane header's row, and drafts get a pane body

const TITLE_HIDDEN_ATTRIBUTE = "data-bbw-hidden";

interface HeaderSlots {
  /** Where the tab strip and + go. */
  bar: HTMLElement;
  /** Where the workspace name goes, in place of the thread title; null in row mode. */
  name: HTMLElement | null;
  /** The node the draft pane is inserted after: the header, or our own row. */
  paneAfter: HTMLElement;
  /** The pane's <header>. */
  header: HTMLElement;
}

/**
 * Put the workspace into the pane header's own row. The header slot is a
 * 256px box among the right-hand actions, too small for tabs, so the slot
 * component only anchors us. We find the header's title group, hide the
 * thread title (the active tab shows it), put the workspace name in its
 * place, and the tabs after the thread's ⋯ menu. If BB's header no longer has
 * that shape, fall back to a row of our own under the header.
 */
function useHeaderSlots(anchor: RefObject<HTMLElement | null>) {
  const [slots, setSlots] = useState<HeaderSlots | null>(null);
  useLayoutEffect(() => {
    const header = anchor.current?.closest("header");
    if (!header?.parentElement) return;
    const left = header.querySelector('[data-testid="app-page-header-content-row"]')?.firstElementChild;
    const titleGroup = left?.firstElementChild;
    const title = titleGroup?.firstElementChild;

    if (left instanceof HTMLElement && titleGroup instanceof HTMLElement && title instanceof HTMLElement) {
      const name = document.createElement("div");
      name.className = "bbw-name-slot";
      const bar = document.createElement("div");
      bar.className = "bbw-header-bar";
      titleGroup.prepend(name);
      titleGroup.after(bar);
      title.setAttribute(TITLE_HIDDEN_ATTRIBUTE, "true");
      setSlots({ bar, name, paneAfter: header, header });
      return () => {
        name.remove();
        bar.remove();
        title.removeAttribute(TITLE_HIDDEN_ATTRIBUTE);
        setSlots(null);
      };
    }

    const row = document.createElement("div");
    row.className = "bbw-row";
    header.after(row);
    setSlots({ bar: row, name: null, paneAfter: row, header });
    return () => {
      row.remove();
      setSlots(null);
    };
  }, [anchor]);
  return slots;
}

/**
 * The pane body of the "New agent" tab: a node of our own in the pane column,
 * below the header. While it exists, CSS hides the thread's chat without
 * unmounting it, so switching back loses nothing.
 */
function useDraftPane(after: HTMLElement | null, open: boolean) {
  const [pane, setPane] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const column = after?.parentElement;
    if (!open || !after || !column) return;
    const node = document.createElement("div");
    node.className = "bbw-draft";
    after.after(node);
    column.setAttribute(DRAFT_ATTRIBUTE, "true");
    setPane(node);
    return () => {
      node.remove();
      column.removeAttribute(DRAFT_ATTRIBUTE);
      setPane(null);
    };
  }, [after, open]);
  return pane;
}

/**
 * BB builds with a thread main pane (wy3z/bb feat/main-pane-tabs) draw a tab
 * strip under the header: "Chat" plus panel tabs moved beside the chat. The
 * agent tabs join that row instead of a second one, in place of its Chat
 * pill. BB draws the row only once a panel tab has moved; until then, and on
 * stock BB, this returns null and the tabs stay in the header row.
 */
interface MainStripSlot {
  /** Where the agent tabs go. */
  container: HTMLElement;
  /** The slot under the header; the New agent pane goes after it. */
  stripHost: HTMLElement;
  /** BB's Chat pill, hidden while the agent tabs stand in for it. */
  chatButton: HTMLButtonElement;
  /** Whether the chat (not a moved panel tab) is showing. */
  chatActive: boolean;
}

const MAIN_STRIP_SELECTOR = "[data-thread-main-pane-strip]";
const MAIN_TABS_SELECTOR = "[data-thread-main-pane-tabs]";

function useMainStripSlot(header: HTMLElement | null) {
  const [slot, setSlot] = useState<MainStripSlot | null>(null);
  useLayoutEffect(() => {
    const stripHost = header?.parentElement?.querySelector<HTMLElement>(MAIN_STRIP_SELECTOR);
    if (!stripHost) return;
    const container = document.createElement("div");
    container.className = "bbw-main-tabs";
    let hiddenChat: Element | null = null;

    const place = () => {
      const toolbar = stripHost.querySelector<HTMLElement>(`:scope > ${MAIN_TABS_SELECTOR}`);
      if (toolbar && container.parentElement !== toolbar) toolbar.prepend(container);
      const chat = toolbar ? container.nextElementSibling : null;
      if (chat !== hiddenChat) {
        hiddenChat?.removeAttribute(TITLE_HIDDEN_ATTRIBUTE);
        hiddenChat = chat;
        hiddenChat?.setAttribute(TITLE_HIDDEN_ATTRIBUTE, "true");
      }
      const chatButton = chat?.querySelector("button") ?? null;
      if (!chatButton) {
        container.remove();
        setSlot(null);
        return;
      }
      const chatActive = chatButton.getAttribute("aria-pressed") === "true";
      setSlot((current) =>
        current?.chatButton === chatButton && current.chatActive === chatActive
          ? current
          : { container, stripHost, chatButton, chatActive },
      );
    };

    const observer = new MutationObserver(place);
    observer.observe(stripHost, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-pressed"],
    });
    place();
    return () => {
      observer.disconnect();
      hiddenChat?.removeAttribute(TITLE_HIDDEN_ATTRIBUTE);
      container.remove();
      setSlot(null);
    };
  }, [header]);
  return slot;
}

function WorkspaceHeader(props: ThreadHeaderActionProps) {
  const anchor = useRef<HTMLSpanElement>(null);
  const slots = useHeaderSlots(anchor);
  return (
    <>
      <span ref={anchor} className="bbw-anchor" />
      <WorkspaceTabRow {...props} slots={slots} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Tab row

function WorkspaceTabRow({
  threadId,
  projectId,
  slots,
}: ThreadHeaderActionProps & { slots: HeaderSlots | null }) {
  const { workspaceId, tabs, current, name, isExplicit, draftOpen } = useWorkspace(threadId);
  const { values } = useSettings();
  const profiles = useMemo(() => parseTerminalProfiles(values?.terminalProfiles), [values]);
  const navigate = useBbNavigate();
  const sdk = useSdk();
  const addButton = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<"closed" | "open" | "browser">("closed");
  const [draftActive, setDraftActive] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const showDraft = draftActive && draftOpen;
  const mainStrip = useMainStripSlot(slots?.header ?? null);
  const draftPane = useDraftPane(mainStrip?.stripHost ?? slots?.paneAfter ?? null, showDraft);
  const environmentId = current?.environment?.id ?? null;
  const tabIds = tabs.map((thread) => thread.id);
  const openThreadTab = (id: string) => {
    if (id !== threadId) {
      navigate.toThread(id);
      return;
    }
    setDraftActive(false);
    if (mainStrip && !mainStrip.chatActive) mainStrip.chatButton.click();
  };

  useEffect(() => setDraftActive(false), [threadId]);

  const startAgent = () => {
    setMenu("closed");
    if (!environmentId || !workspaceId) return;
    // Without our slots there is nowhere to draw the tab; use BB's compose page.
    if (!slots) {
      navigate.toCompose({ projectId, environmentId, focusPrompt: true });
      return;
    }
    setDraftOpen(workspaceId, true);
    setDraftActive(true);
  };

  const closeDraft = () => {
    if (workspaceId) setDraftOpen(workspaceId, false);
    setDraftActive(false);
  };

  const closeTab = async (thread: PluginSidebarThread) => {
    const busy = thread.status === "active" || thread.status === "starting";
    if (busy && !window.confirm(`"${thread.displayTitle}" is still working. Archive it anyway?`)) {
      return;
    }
    if (thread.id === threadId) {
      const neighbour = adjacentTab(tabIds, threadId, -1);
      if (neighbour) navigate.toThread(neighbour);
    }
    try {
      await sdk.threads.archive({ threadId: thread.id });
    } catch (error) {
      console.warn("[workspaces] could not archive the thread", error);
    }
  };

  const moveTab = (movedId: string, index: number) => {
    const others = tabs.filter((thread) => thread.id !== movedId);
    const before = others[index - 1];
    const after = others[index];
    void updateMeta(sdk, movedId, {
      tabOrder: orderBetween(
        before ? tabOrderOf(before) : undefined,
        after ? tabOrderOf(after) : undefined,
      ),
    });
  };

  const openUrlInMainPane = (url: string) => {
    const openUrl = navigate.openUrl as (
      url: string,
      options?: { experimental_placement?: "main" | "panel" },
    ) => boolean;
    openUrl(url, { experimental_placement: "main" });
  };

  const renameWorkspace = (next: string) => {
    const value = next.trim() || null;
    for (const thread of tabs) void updateMeta(sdk, thread.id, { workspaceName: value });
  };

  const openTerminal = async (profile: TerminalProfile | null) => {
    setMenu("closed");
    try {
      const session = await sdk.terminals.create({
        scope: { kind: "thread", threadId },
        cols: 120,
        rows: 32,
        title: profile?.name,
        start: profile ? { mode: "command", command: profile.command } : undefined,
      });
      await navigate.experimental_openTerminal({ terminalId: session.id });
    } catch (error) {
      console.warn("[workspaces] could not open a terminal", error);
    }
  };

  useEffect(() => {
    const onCommand = (event: Event) => {
      const detail = (event as CustomEvent<{ action: CommandAction; threadId: string }>).detail;
      if (detail?.threadId !== threadId) return;
      const action = detail.action;
      if (action.startsWith("tab-")) {
        const target = tabIds[Number(action.slice(4)) - 1];
        if (target) openThreadTab(target);
        return;
      }
      switch (action) {
        case "next":
        case "previous": {
          const target = adjacentTab(tabIds, threadId, action === "next" ? 1 : -1);
          if (target) openThreadTab(target);
          break;
        }
        case "new-agent":
          startAgent();
          break;
        case "new-terminal":
          void openTerminal(null);
          break;
        case "new-browser":
          setMenu("browser");
          break;
        case "detach":
          void updateMeta(sdk, threadId, { workspaceId: selfWorkspaceId(threadId) });
          break;
        case "rejoin":
          if (isExplicit) void updateMeta(sdk, threadId, { workspaceId: null });
          break;
      }
    };
    window.addEventListener(COMMAND_EVENT, onCommand);
    return () => window.removeEventListener(COMMAND_EVENT, onCommand);
  });

  if (!current || !workspaceId) return null;

  const dropAt = (event: DragEvent<HTMLElement>, index: number) => {
    if (!dragging) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    setDropIndex(event.clientX > rect.left + rect.width / 2 ? index + 1 : index);
  };

  const workspaceName = (
    <WorkspaceName
      name={name}
      fallback={tabs[0]?.displayTitle ?? current.displayTitle}
      onRename={renameWorkspace}
    />
  );
  // One tab is just the workspace; the name already says which thread it is.
  // In BB's main-pane row the current thread's tab stands in for "Chat", so
  // it always shows there.
  const showTabs = mainStrip !== null || tabs.length > 1 || draftOpen;
  const chatShowing = mainStrip?.chatActive ?? true;

  const addButtonElement = (
    <button
      ref={addButton}
      type="button"
      className="bbw-add"
      aria-label="Add to this workspace"
      aria-haspopup="menu"
      aria-expanded={menu !== "closed"}
      onClick={() => setMenu(menu === "closed" ? "open" : "closed")}
    >
      <Icon name="Plus" className="bbw-icon" aria-hidden />
    </button>
  );

  const strip = (
      <div
        className="bbw-strip"
        role="tablist"
        aria-label="Workspace"
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropIndex(null);
        }}
      >
        {showTabs && tabs.map((thread, index) => (
          <AgentTab
            key={thread.id}
            thread={thread}
            active={!showDraft && chatShowing && thread.id === threadId}
            closable={tabs.length > 1}
            dropBefore={dragging !== null && dropIndex === index}
            dropAfter={dragging !== null && dropIndex === tabs.length && index === tabs.length - 1}
            onSelect={() => openThreadTab(thread.id)}
            onClose={() => void closeTab(thread)}
            onDragStart={() => setDragging(thread.id)}
            onDragOver={(event) => dropAt(event, index)}
            onDrop={(event) => {
              event.preventDefault();
              if (dragging && dropIndex !== null) {
                const from = tabIds.indexOf(dragging);
                const to = dropIndex > from ? dropIndex - 1 : dropIndex;
                if (to !== from) moveTab(dragging, to);
              }
              setDragging(null);
              setDropIndex(null);
            }}
            onDragEnd={() => {
              setDragging(null);
              setDropIndex(null);
            }}
          />
        ))}
        {draftOpen && (
          <div
            className="bbw-tab"
            role="tab"
            aria-selected={showDraft}
            data-active={showDraft}
            onClick={() => setDraftActive(true)}
          >
            <Icon name="MessageSquarePlus" className="bbw-icon" aria-hidden />
            <span className="bbw-title">New agent</span>
            <button
              type="button"
              className="bbw-tab-close"
              aria-label="Close new agent tab"
              onClick={(event) => {
                event.stopPropagation();
                closeDraft();
              }}
            >
              <Icon name="X" className="bbw-icon" aria-hidden />
            </button>
          </div>
        )}
        {mainStrip ? null : addButtonElement}
      </div>
  );

  const bar = (
    <div className="bbw-bar">
      {slots?.name ? createPortal(workspaceName, slots.name) : workspaceName}
      {mainStrip ? <div className="bbw-header-actions">{addButtonElement}</div> : strip}
      {menu !== "closed" && (
        <AddMenu
          anchor={addButton.current}
          browserFirst={menu === "browser"}
          profiles={profiles}
          canAddAgent={environmentId !== null}
          onClose={() => setMenu("closed")}
          onAgent={startAgent}
          onTerminal={(profile) => void openTerminal(profile)}
          onBrowser={(url) => {
            setMenu("closed");
            openUrlInMainPane(url);
          }}
        />
      )}
      {draftPane &&
        environmentId &&
        createPortal(
          <DraftAgent
            projectId={projectId}
            environmentId={environmentId}
            workspaceId={workspaceId}
            workspaceName={name}
            onDone={closeDraft}
          />,
          draftPane,
        )}
    </div>
  );

  const target = slots?.bar ?? null;
  return (
    <>
      {target ? createPortal(bar, target) : <div className="bbw-inline">{bar}</div>}
      {mainStrip && createPortal(strip, mainStrip.container)}
    </>
  );
}

function WorkspaceName({
  name,
  fallback,
  onRename,
}: {
  name: string | null;
  fallback: string;
  onRename: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name ?? "");

  if (editing) {
    return (
      <form
        className="bbw-name"
        onSubmit={(event) => {
          event.preventDefault();
          setEditing(false);
          if (value.trim() !== (name ?? "")) onRename(value);
        }}
      >
        <input
          autoFocus
          aria-label="Workspace name"
          placeholder={fallback}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onBlur={(event) => event.currentTarget.form?.requestSubmit()}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setValue(name ?? "");
              setEditing(false);
            }
          }}
        />
      </form>
    );
  }

  return (
    <button
      type="button"
      className="bbw-name"
      data-unnamed={name === null}
      title="Double-click to rename"
      onDoubleClick={() => {
        setValue(name ?? "");
        setEditing(true);
      }}
    >
      <span className="bbw-title">{name ?? fallback}</span>
    </button>
  );
}

function AgentTab({
  thread,
  active,
  closable,
  dropBefore,
  dropAfter,
  onSelect,
  onClose,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  thread: PluginSidebarThread;
  active: boolean;
  closable: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
  onSelect: () => void;
  onClose: () => void;
  onDragStart: () => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}) {
  const rowStatus = useSidebarThreadRowStatus(thread.id);
  return (
    <ThreadActionsContextMenu thread={toActionTarget(thread)}>
      <div
        role="tab"
        tabIndex={0}
        aria-selected={active}
        className="bbw-tab"
        data-active={active}
        data-drop-before={dropBefore || undefined}
        data-drop-after={dropAfter || undefined}
        title={`${thread.displayTitle} · ${thread.providerId}`}
        draggable
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect();
          }
        }}
        onAuxClick={(event) => {
          if (event.button === 1 && closable) onClose();
        }}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", thread.id);
          onDragStart();
        }}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragEnd={onDragEnd}
      >
        <ThreadStatusGlyph indicator={thread.indicator} rowStatus={rowStatus} size="compact" />
        <span className="bbw-title">
          <ThreadTitle threadId={thread.id} />
        </span>
        {closable && (
          <button
            type="button"
            className="bbw-tab-close"
            aria-label={`Archive ${thread.displayTitle}`}
            title="Close (archives the thread)"
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
          >
            <Icon name="X" className="bbw-icon" aria-hidden />
          </button>
        )}
      </div>
    </ThreadActionsContextMenu>
  );
}

// ---------------------------------------------------------------------------
// + menu

function MenuItem({
  icon,
  label,
  hint,
  disabled,
  onSelect,
}: {
  icon: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button type="button" role="menuitem" className="bbw-item" disabled={disabled} onClick={onSelect}>
      <Icon name={icon} className="bbw-icon" aria-hidden />
      <span className="bbw-item-label">{label}</span>
      {hint && <kbd className="bbw-hint">{hint}</kbd>}
    </button>
  );
}

function AddMenu({
  anchor,
  browserFirst,
  profiles,
  canAddAgent,
  onClose,
  onAgent,
  onTerminal,
  onBrowser,
}: {
  anchor: HTMLElement | null;
  browserFirst: boolean;
  profiles: readonly TerminalProfile[];
  canAddAgent: boolean;
  onClose: () => void;
  onAgent: () => void;
  onTerminal: (profile: TerminalProfile | null) => void;
  onBrowser: (url: string) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [askUrl, setAskUrl] = useState(browserFirst);
  const [url, setUrl] = useState("http://localhost:");
  const rect = anchor?.getBoundingClientRect();
  const mod = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+";

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !anchor?.contains(target)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [anchor, onClose]);

  const style = rect
    ? { top: rect.bottom + 4, left: Math.min(rect.left, window.innerWidth - 260) }
    : { top: 64, left: 64 };

  return createPortal(
    <div ref={menu} className="bbw-menu" role="menu" style={style}>
      <MenuItem icon="MessageSquarePlus" label="Agent" hint={`${mod}Shift+A`} disabled={!canAddAgent} onSelect={onAgent} />
      <MenuItem icon="Terminal" label="Terminal" hint={`${mod}Alt+T`} onSelect={() => onTerminal(null)} />
      {askUrl ? (
        <form
          className="bbw-url"
          onSubmit={(event) => {
            event.preventDefault();
            const value = url.trim();
            if (value) onBrowser(/^[a-z]+:\/\//i.test(value) ? value : `http://${value}`);
          }}
        >
          <Icon name="Globe" className="bbw-icon" aria-hidden />
          <input
            autoFocus
            aria-label="URL to open"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </form>
      ) : (
        <MenuItem icon="Globe" label="Browser" hint={`${mod}Shift+B`} onSelect={() => setAskUrl(true)} />
      )}
      {profiles.length > 0 && (
        <>
          <div className="bbw-sep" />
          <div className="bbw-group">Terminal profiles</div>
          {profiles.map((profile) => (
            <MenuItem
              key={profile.name}
              icon="Bot"
              label={profile.name}
              onSelect={() => onTerminal(profile)}
            />
          ))}
        </>
      )}
      <div className="bbw-sep" />
      <div className="bbw-foot">Edit profiles in Settings → Plugins → Workspaces</div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// New agent tab

function DraftAgent({
  projectId,
  environmentId,
  workspaceId,
  workspaceName,
  onDone,
}: {
  projectId: string;
  environmentId: string;
  workspaceId: string;
  workspaceName: string | null;
  onDone: () => void;
}) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="bbw-draft-inner">
      <div className="bbw-draft-title">New agent</div>
      <div className="bbw-draft-note">Works in this workspace's directory, alongside the other tabs.</div>
      <NewThreadComposer
        defaultProjectId={projectId}
        defaultEnvironment={{ type: "reuse", environmentId }}
        placeholder="What should this agent do?"
        draftKey={`bb-workspaces:${workspaceId}`}
        focusRequest={1}
        onSubmit={async (request) => {
          setError(null);
          const pluginMetadata: Record<string, string> = { [WORKSPACE_ID_KEY]: workspaceId };
          if (workspaceName) pluginMetadata[WORKSPACE_NAME_KEY] = workspaceName;
          try {
            const thread = await sdk.threads.spawn({ ...request, pluginMetadata });
            meta.set(thread.id, readThreadMeta(pluginMetadata));
            fetched.add(thread.id);
            window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
            onDone();
            navigate.toThread(thread.id);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        }}
      />
      {error && <p className="bbw-error">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Commands

function command(
  id: CommandAction,
  title: string,
  defaultShortcut?: { key: string; mod?: boolean; alt?: boolean; shift?: boolean },
) {
  return {
    id,
    title,
    defaultShortcut,
    isAvailable: (context: { threadId: string | null }) => context.threadId !== null,
    run: (context: { threadId: string | null }) => {
      if (!context.threadId) return;
      window.dispatchEvent(
        new CustomEvent(COMMAND_EVENT, { detail: { action: id, threadId: context.threadId } }),
      );
    },
  };
}

export default definePluginApp((app) => {
  registerThreadHeaderAction(app.slots, {
    id: "tabs",
    title: "Workspace tabs",
    component: WorkspaceHeader,
  });

  app.commands.register(command("new-agent", "Workspace: add an agent", { key: "a", mod: true, shift: true }));
  app.commands.register(command("new-terminal", "Workspace: open a terminal", { key: "t", mod: true, alt: true }));
  app.commands.register(command("new-browser", "Workspace: open a browser", { key: "b", mod: true, shift: true }));
  app.commands.register(command("next", "Workspace: next tab", { key: "]", mod: true, alt: true }));
  app.commands.register(command("previous", "Workspace: previous tab", { key: "[", mod: true, alt: true }));
  for (let index = 1; index <= JUMP_TABS; index += 1) {
    app.commands.register(
      command(`tab-${index}`, `Workspace: jump to tab ${index}`, { key: String(index), mod: true, alt: true }),
    );
  }
  app.commands.register(command("detach", "Workspace: move this thread to its own workspace"));
  app.commands.register(command("rejoin", "Workspace: reset this thread's workspace"));
});
