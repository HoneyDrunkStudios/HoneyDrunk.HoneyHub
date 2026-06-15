import type { AgentBackend } from "@honeydrunk/honeyhub-types";

// HoneyHub-native slash commands (parity polish #9). The bridge drives the CLIs
// non-interactively, so it can't pass the CLIs' own interactive slash commands through —
// these are *cockpit* actions that map a typed `/command` to a composer state change
// (switch cost mode, pin a model, set the agent/effort, start a new chat). The set is
// provider-aware: agent commands appear only for Claude, effort commands only for a Codex
// model that exposes reasoning levels. Pure + data-driven so it is trivially testable.

/** A command's stable action id. Value-carrying actions encode the value in the id
    (`effort:high`, `agent:reviewer`) so the dispatcher can apply it directly. */
export interface SlashCommand {
  id: string;
  /** The `/…` token shown in the menu. */
  label: string;
  hint: string;
}

export interface SlashContext {
  provider: AgentBackend;
  costMode: "optimize" | "manual";
  /** Agent names runnable on the current provider (Claude only, in practice). */
  agents: string[];
  /** Reasoning-effort levels for the selected model (Codex only). */
  effortLevels: string[];
}

/** The commands available in the current context, in display order. */
export function availableSlashCommands(ctx: SlashContext): SlashCommand[] {
  const commands: SlashCommand[] = [
    { id: "new", label: "/new", hint: "Start a new chat" },
    { id: "clear", label: "/clear", hint: "Clear the composer" }
  ];
  if (ctx.costMode === "manual") {
    commands.push({ id: "optimize", label: "/optimize", hint: "Let HoneyHub pick the cheapest model" });
  } else {
    commands.push({ id: "model", label: "/model", hint: "Pick an exact provider + model" });
  }
  for (const level of ctx.effortLevels) {
    commands.push({
      id: `effort:${level}`,
      label: `/effort ${level}`,
      hint: "Set the Codex reasoning effort"
    });
  }
  for (const agent of ctx.agents) {
    commands.push({
      id: `agent:${agent}`,
      label: `/agent ${agent}`,
      hint: "Run under this agent"
    });
  }
  return commands;
}

/** Whether the composer text is in "slash command" mode: it begins with `/` and has no
    space yet on the first line (a space means the user moved on to prose). */
export function isSlashQuery(text: string): boolean {
  return text.startsWith("/");
}

/** The query portion (everything after the leading `/`, lowercased, trimmed of a
    trailing newline). */
export function slashQuery(text: string): string {
  return text.replace(/^\//, "").toLowerCase();
}

/** Filter commands by the query: a case-insensitive substring match over the label
    (minus its leading `/`) and the hint, so `/eff` and `/high` both find effort commands. */
export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return commands;
  }
  return commands.filter((command) => {
    const label = command.label.replace(/^\//, "").toLowerCase();
    return label.includes(needle) || command.hint.toLowerCase().includes(needle);
  });
}
