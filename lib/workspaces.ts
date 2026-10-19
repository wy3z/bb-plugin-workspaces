// Workspace membership. A workspace is a set of threads shown as tabs.
//
// Each thread resolves to a workspace id, first match wins:
//   1. an explicit id stored in this plugin's thread metadata
//   2. for top-level threads, their worktree environment, so threads sharing
//      a worktree group up
//   3. itself, so every thread is a workspace of one
//
// Delegated and forked threads never join by default: the sidebar already
// nests them under their parent. Project checkouts are not grouped by
// environment either, because one checkout can hold hundreds of unrelated
// threads.

export const WORKSPACE_ID_KEY = "workspaceId";
export const TAB_ORDER_KEY = "tabOrder";
export const WORKSPACE_NAME_KEY = "workspaceName";

export interface ThreadMeta {
  workspaceId?: string;
  tabOrder?: number;
  workspaceName?: string;
}

export interface WorkspaceThread {
  id: string;
  parentThreadId: string | null;
  environmentId: string | null;
  isWorktree: boolean;
  /** Sort key for the tab row: the saved tab order, else creation time. */
  order: number;
}

export function selfWorkspaceId(threadId: string): string {
  return `thread:${threadId}`;
}

export function environmentWorkspaceId(environmentId: string): string {
  return `env:${environmentId}`;
}

export function readThreadMeta(metadata: unknown): ThreadMeta {
  if (!metadata || typeof metadata !== "object") return {};
  const record = metadata as Record<string, unknown>;
  const meta: ThreadMeta = {};
  const workspaceId = record[WORKSPACE_ID_KEY];
  if (typeof workspaceId === "string" && workspaceId) meta.workspaceId = workspaceId;
  const tabOrder = record[TAB_ORDER_KEY];
  if (typeof tabOrder === "number" && Number.isFinite(tabOrder)) meta.tabOrder = tabOrder;
  const workspaceName = record[WORKSPACE_NAME_KEY];
  if (typeof workspaceName === "string" && workspaceName.trim()) {
    meta.workspaceName = workspaceName.trim();
  }
  return meta;
}

export function resolveWorkspaceIds(
  threads: readonly WorkspaceThread[],
  explicit: ReadonlyMap<string, string>,
): Map<string, string> {
  const resolved = new Map<string, string>();
  for (const thread of threads) {
    const id =
      explicit.get(thread.id) ??
      (!thread.parentThreadId && thread.isWorktree && thread.environmentId
        ? environmentWorkspaceId(thread.environmentId)
        : selfWorkspaceId(thread.id));
    resolved.set(thread.id, id);
  }
  return resolved;
}

/** Ids of the threads in `threadId`'s workspace, in tab order. */
export function workspaceTabs(
  threadId: string,
  threads: readonly WorkspaceThread[],
  resolved: ReadonlyMap<string, string>,
): string[] {
  const workspaceId = resolved.get(threadId);
  if (!workspaceId) return [];
  return threads
    .filter((thread) => resolved.get(thread.id) === workspaceId)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((thread) => thread.id);
}

/** The tab `offset` steps from `threadId`, wrapping; null with fewer than two tabs. */
export function adjacentTab(
  tabs: readonly string[],
  threadId: string,
  offset: number,
): string | null {
  if (tabs.length < 2) return null;
  const index = tabs.indexOf(threadId);
  if (index < 0) return null;
  const next = (((index + offset) % tabs.length) + tabs.length) % tabs.length;
  return tabs[next] ?? null;
}

/**
 * A sort key that puts a moved tab between two neighbours. Only the moved tab
 * is written, so a reorder is one metadata update.
 */
export function orderBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return Date.now();
  if (before === undefined) return (after as number) - 1;
  if (after === undefined) return before + 1;
  return (before + after) / 2;
}
