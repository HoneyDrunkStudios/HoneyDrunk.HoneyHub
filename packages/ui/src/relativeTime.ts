import { useEffect, useState } from "react";

// Shared "updated N ago" freshness helpers, used across the Hub overview and the connector
// panels so every surface stamps freshness the same way.

/** Format how long ago `thenMs` was, relative to `nowMs`. Coarse on purpose ("just now",
    "3m ago", "2h ago", "5d ago") — a glanceable freshness hint, not a clock. */
export function formatRelative(nowMs: number, thenMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (seconds < 10) {
    return "just now";
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** A clock that re-renders relative stamps periodically while a tab is active (and resets on
    activation). Returns the current epoch ms. Inert while inactive to avoid wasted renders. */
export function useRelativeNow(active: boolean): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
