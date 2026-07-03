import { describe, expect, it } from "vitest";
import type { BackendModel } from "@honeydrunk/honeyhub-types";
import {
  approximateTokens,
  describeEstimate,
  estimateRunCost,
  formatEstimateUsd,
  modelIdMatches,
  resolveCatalogModel,
  type CostHistoryEntry
} from "./costEstimate";

const opus: BackendModel = {
  id: "opus",
  label: "Claude Opus 4.8",
  pricing: { inputUsdPerMtok: 5, outputUsdPerMtok: 25 }
};
const fable: BackendModel = {
  id: "fable",
  label: "Claude Fable 5",
  pricing: { inputUsdPerMtok: 10, outputUsdPerMtok: 50 },
  metered: true
};
const unpriced: BackendModel = { id: "gpt-5.5", label: "GPT-5.5" };

const history: CostHistoryEntry[] = [
  { backend: "claude.local", model: "claude-opus-4-8", totalUsd: 0.4 },
  { backend: "claude.local", model: "claude-opus-4-8", totalUsd: 0.1 },
  { backend: "claude.local", model: "claude-opus-4-8", totalUsd: 1.8 },
  { backend: "claude.local", model: "claude-fable-5", totalUsd: 9.0 },
  { backend: "codex.local", model: "gpt-5.5", totalUsd: 0.7 },
  { backend: "claude.local", model: "claude-opus-4-8", totalUsd: 0 } // never billed → excluded
];

describe("model matching", () => {
  it("matches aliases as whole segments of the recorded id, never substrings", () => {
    expect(modelIdMatches("claude-opus-4-8", "opus")).toBe(true);
    expect(modelIdMatches("claude-fable-5", "fable")).toBe(true);
    expect(modelIdMatches("gpt-5-codex", "gpt-5-codex")).toBe(true);
    // A sibling model whose id merely contains the picked id must NOT match.
    expect(modelIdMatches("gpt-5-codex", "gpt-5")).toBe(false);
    expect(modelIdMatches("gpt-5.5", "gpt-5")).toBe(false);
    expect(modelIdMatches(undefined, "opus")).toBe(false);
  });

  it("resolves exact ids, aliases, and custom full ids against the catalog", () => {
    const models = [opus, fable];
    expect(resolveCatalogModel(models, "opus")).toBe(opus);
    // A custom full id typed by the user still resolves to its catalog entry, so
    // billing flags (metered) are honored.
    expect(resolveCatalogModel(models, "claude-fable-5")).toBe(fable);
    expect(resolveCatalogModel(models, "totally-unknown")).toBeUndefined();
    expect(resolveCatalogModel(models, undefined)).toBeUndefined();
  });
});

describe("estimateRunCost", () => {
  it("reports included on a flat plan for a resolved non-metered model", () => {
    const estimate = estimateRunCost({
      task: "do a thing",
      backend: "claude.local",
      model: opus,
      plan: { type: "flat", monthlyUsd: 100 },
      history
    });
    expect(estimate).toEqual({ kind: "included" });
  });

  it("never claims an unresolved model is included in the plan", () => {
    expect(
      estimateRunCost({
        task: "do a thing",
        backend: "claude.local",
        model: undefined,
        plan: { type: "flat", monthlyUsd: 100 },
        history
      })
    ).toBeUndefined();
  });

  it("still bills metered models on a flat plan", () => {
    const estimate = estimateRunCost({
      task: "x".repeat(400),
      backend: "claude.local",
      model: fable,
      plan: { type: "flat", monthlyUsd: 100 },
      history
    });
    expect(estimate?.kind).toBe("estimate");
    if (estimate?.kind === "estimate") {
      // 100 tokens at $10/MTok = $0.001.
      expect(estimate.inputFloorUsd).toBeCloseTo(0.001, 6);
      expect(estimate.history?.typicalUsd).toBe(9.0);
      expect(estimate.history?.sampleSize).toBe(1);
    }
  });

  it("projects median and p90 from same-backend same-model history", () => {
    const estimate = estimateRunCost({
      task: "hello",
      backend: "claude.local",
      model: opus,
      plan: { type: "unset" },
      history
    });
    expect(estimate?.kind).toBe("estimate");
    if (estimate?.kind === "estimate") {
      expect(estimate.history?.sampleSize).toBe(3); // the $0 chat is excluded
      expect(estimate.history?.typicalUsd).toBe(0.4);
      expect(estimate.history?.highUsd).toBe(1.8);
    }
  });

  it("returns undefined without a rate, history, or prompt text", () => {
    expect(
      estimateRunCost({
        task: "hello",
        backend: "codex.local",
        model: unpriced,
        plan: { type: "unset" },
        history: []
      })
    ).toBeUndefined();
    expect(
      estimateRunCost({
        task: "",
        backend: "claude.local",
        model: opus,
        plan: { type: "unset" },
        history: []
      })
    ).toBeUndefined();
  });
});

describe("formatting", () => {
  it("approximates tokens at chars/4", () => {
    expect(approximateTokens("")).toBe(0);
    expect(approximateTokens("abcd")).toBe(1);
    expect(approximateTokens("abcde")).toBe(2);
  });

  it("uses the centralized estimated-money prefix and keeps sub-cent costs visible", () => {
    expect(formatEstimateUsd(1.5)).toBe("~$1.50");
    expect(formatEstimateUsd(0.05)).toBe("~$0.050");
    expect(formatEstimateUsd(0.0004)).toBe("~$0.0004");
  });

  it("describes included, ranged, and floor-only estimates", () => {
    expect(describeEstimate({ kind: "included" })).toBe("Included in your plan");
    expect(describeEstimate(undefined)).toBeUndefined();
    expect(
      describeEstimate({
        kind: "estimate",
        history: { typicalUsd: 0.4, highUsd: 1.8, sampleSize: 3 }
      })
    ).toBe("~$0.40 typical · up to ~$1.80 (3 similar chats)");
    expect(describeEstimate({ kind: "estimate", inputFloorUsd: 0.002 })).toBe(
      "≥ ~$0.0020 to send"
    );
  });
});
