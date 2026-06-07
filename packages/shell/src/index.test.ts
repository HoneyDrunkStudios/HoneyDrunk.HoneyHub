import assert from "node:assert/strict";
import test from "node:test";
import { shellDescriptor } from "./index.js";

test("shell descriptor declares bundled bridge intent", () => {
  assert.equal(shellDescriptor.bundlesBridge, true);
  assert.equal(shellDescriptor.toolkit, "tauri-class");
});
