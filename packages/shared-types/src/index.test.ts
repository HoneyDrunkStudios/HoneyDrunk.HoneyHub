import assert from "node:assert/strict";
import test from "node:test";
import { defaultClaudeCapabilities } from "./index.js";

test("default Claude capabilities declare exact usage and live replies", () => {
  assert.equal(defaultClaudeCapabilities.interactive_reply, true);
  assert.equal(defaultClaudeCapabilities.usage_exact, true);
  assert.equal(defaultClaudeCapabilities.usage_estimated, false);
});
