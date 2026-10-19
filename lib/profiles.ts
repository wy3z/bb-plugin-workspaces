// Terminal profiles: CLI agents (or anything else) launched in a terminal from
// the + menu, like Paseo's terminal profiles.

export interface TerminalProfile {
  name: string;
  command: string;
}

export const DEFAULT_TERMINAL_PROFILES = [
  "Claude Code=claude",
  "Codex=codex",
  "OpenCode=opencode",
  "Pi=pi",
].join("\n");

export function parseTerminalProfiles(value: unknown): TerminalProfile[] {
  const text = typeof value === "string" ? value : DEFAULT_TERMINAL_PROFILES;
  const profiles: TerminalProfile[] = [];
  for (const line of text.split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    const command = line.slice(separator + 1).trim();
    if (name && command) profiles.push({ name, command });
  }
  return profiles;
}
