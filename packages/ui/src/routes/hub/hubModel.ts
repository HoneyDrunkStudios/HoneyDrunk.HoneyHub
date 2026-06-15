// Pure helpers for the Hub overview (the "one glance" landing): the tone for a headline number
// (so a non-zero dead-letter or error count reads as a warning). The relative-time formatter
// lives in the shared `relativeTime` util; re-exported here for existing call sites.

export { formatRelative } from "../../relativeTime";

export type CardTone = "ok" | "warn" | "muted";

/** A non-zero "attention" count (dead-letter, unresolved errors) is a warning; zero is OK. */
export function attentionTone(count: number): CardTone {
  return count > 0 ? "warn" : "ok";
}
