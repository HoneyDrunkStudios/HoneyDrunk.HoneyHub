import type { BridgeEvent, StartRunRequest } from "@honeydrunk/honeyhub-types";

// The PWA's view of the packet-04 wire protocol. The run screen depends only on
// this seam, so the same UI drives a mock (tests / offline demo) and, once the
// bridge transport server lands (the relay/shell bringup), a real WebSocket
// client that presents the pairing token on connect — without any UI change.

export type WireEventHandler = (event: BridgeEvent) => void;

export interface StartedRun {
  runId: string;
}

export interface WireClient {
  /** Begin a run; the bridge streams events for it via `subscribe`. */
  start(request: StartRunRequest): Promise<StartedRun>;
  /** Send a live, same-process reply into an active run (e.g. answering
      `needs_input`). A follow-up after completion is a new run via `start`
      (`StartRunRequest.followUpToRunId` + `transcript`), not a reply here. */
  reply(runId: string, text: string): Promise<void>;
  /** Request graceful cancellation of a run. */
  stop(runId: string): Promise<void>;
  /** Ask the host for the device-wide "your spend" summary. The answer arrives as
      a `usage_summary` server event via `subscribe` (this resolves on the host's
      ack, not with the summary itself), so the caller listens for the event. */
  requestUsageSummary(): Promise<void>;
  /** Subscribe to bridge events; returns an unsubscribe function. */
  subscribe(handler: WireEventHandler): () => void;
}
