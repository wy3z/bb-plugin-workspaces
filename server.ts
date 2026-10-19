import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { DEFAULT_TERMINAL_PROFILES } from "./lib/profiles.js";

export default function plugin(bb: BbPluginApi) {
  bb.settings.define({
    terminalProfiles: {
      type: "string",
      label: "Terminal profiles",
      description:
        "One per line as Name=command. Each shows in the + menu and opens a terminal running that command in the thread's directory.",
      experimental_multiline: true,
      default: DEFAULT_TERMINAL_PROFILES,
    },
  });
}
