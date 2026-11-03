import type { ComponentType } from "react";
import type { PluginAppSlots } from "@get-bb/plugin-sdk/app";

// BB retired `experimental_threadHeaderAction` from the SDK typings in 0.6.104
// but still collects and renders registrations for it, and its replacement --
// a thread action with `placement: "header"` -- is a button rather than a
// component slot. The tab row needs a component, so this plugin supports the
// bb releases that ship the slot and says so in package.json: `engines.bb` is
// pinned below the next minor. If BB drops the slot, `registerThreadHeaderAction`
// throws instead of letting the tab row disappear.

/** Props BB passes to a registered thread header component, as its runtime sends them. */
export interface ThreadHeaderActionProps {
  /** The thread whose header this is. Never null: the slot skips other routes. */
  threadId: string;
  projectId: string;
  /** Phone-width viewport or coarse pointer: the header row is short. */
  isCompactViewport: boolean;
}

export interface ThreadHeaderActionRegistration {
  id: string;
  title: string;
  component: ComponentType<ThreadHeaderActionProps>;
}

interface ThreadHeaderSlotHost {
  experimental_threadHeaderAction(registration: ThreadHeaderActionRegistration): void;
}

function hasThreadHeaderSlot(slots: PluginAppSlots): slots is PluginAppSlots & ThreadHeaderSlotHost {
  if (!("experimental_threadHeaderAction" in slots)) return false;
  const register: unknown = slots.experimental_threadHeaderAction;
  return typeof register === "function";
}

export function registerThreadHeaderAction(
  slots: PluginAppSlots,
  registration: ThreadHeaderActionRegistration,
): void {
  if (!hasThreadHeaderSlot(slots)) {
    throw new Error(
      "bb-plugin-workspaces needs BB's thread header slot (experimental_threadHeaderAction). " +
        "This bb does not provide it, so the workspace tab row cannot be drawn; " +
        "see package.json engines for the supported bb range.",
    );
  }
  slots.experimental_threadHeaderAction(registration);
}
