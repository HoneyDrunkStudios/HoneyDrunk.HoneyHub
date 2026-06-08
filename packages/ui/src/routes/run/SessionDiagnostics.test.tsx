import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DispatchMessage, UsageSignal } from "@honeydrunk/honeyhub-types";
import { SessionDiagnostics } from "./SessionDiagnostics";

const messages: DispatchMessage[] = [
  {
    id: "m1",
    sessionId: "s1",
    runId: "r1",
    role: "agent",
    body: "working",
    createdAt: "2026-06-08T12:00:00Z",
    isPartial: false
  }
];

const usage: UsageSignal[] = [
  {
    id: "u1",
    sessionId: "s1",
    runId: "r1",
    backend: "claude.local",
    fidelity: "exact",
    modelLabel: "claude",
    inputTokens: 1200,
    outputTokens: 340,
    totalTokens: 1540,
    totalUsd: 0.0182,
    recordedAt: "2026-06-08T12:00:00Z"
  }
];

describe("SessionDiagnostics", () => {
  it("shows routing, usage, and message count", () => {
    render(<SessionDiagnostics backend="claude.local" messages={messages} usage={usage} />);
    const panel = screen.getByLabelText("Session diagnostics");
    expect(panel.textContent).toContain("claude.local · claude");
    expect(panel.textContent).toContain("1,540 tok");
    expect(panel.textContent).toContain("$0.0182");
    expect(within(panel).getByText("healthy")).toBeTruthy();
  });

  it("surfaces a switch recommendation for a long session", () => {
    const heavy: UsageSignal[] = [{ ...usage[0]!, totalTokens: 200_000 }];
    render(<SessionDiagnostics backend="claude.local" messages={messages} usage={heavy} />);
    const recs = screen.getByLabelText("Recommendations");
    expect(within(recs).getByText(/fresh session/i)).toBeTruthy();
    expect(screen.getByText("watch")).toBeTruthy();
  });
});
