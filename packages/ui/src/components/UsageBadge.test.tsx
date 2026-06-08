import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { UsageFidelity, UsageSignal } from "@honeydrunk/honeyhub-types";
import { UsageBadge } from "./UsageBadge";

function usage(fidelity: UsageFidelity): UsageSignal {
  return {
    id: "u1",
    sessionId: "s1",
    runId: "r1",
    backend: "claude.local",
    fidelity,
    totalTokens: 1540,
    totalUsd: 0.0182,
    recordedAt: "2026-06-07T12:00:00Z"
  };
}

describe("UsageBadge", () => {
  it("renders exact usage as a plain dollar figure", () => {
    render(<UsageBadge usage={usage("exact")} />);
    expect(screen.getByLabelText("Usage (exact)")).toBeTruthy();
    expect(screen.getByText("$0.0182")).toBeTruthy();
    expect(screen.getByText("exact")).toBeTruthy();
  });

  it("never renders an estimate as an exact number", () => {
    render(<UsageBadge usage={usage("estimated")} />);
    // The estimated figure carries the ~$ band and an "estimated" qualifier; it is
    // not shown as a plain exact "$0.0182".
    expect(screen.getByText("~$0.0182")).toBeTruthy();
    expect(screen.getByText("estimated")).toBeTruthy();
    expect(screen.queryByText("$0.0182")).toBeNull();
    expect(screen.getByLabelText("Usage (estimated)")).toBeTruthy();
  });

  it("marks derived figures with their own band", () => {
    render(<UsageBadge usage={usage("derived")} />);
    expect(screen.getByText("≈$0.0182")).toBeTruthy();
    expect(screen.getByText("derived")).toBeTruthy();
  });
});
