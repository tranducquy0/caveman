// Two copies of the extension in one Pi load set: Pi rejects duplicate tool
// names outright, so the second copy must register nothing. The claim is per load
// pass, not per process — Pi re-runs every factory on ctx.reload() after emitting
// session_shutdown, so a permanent process-wide flag would silently unregister
// caveman_retrieve (and every lifecycle hook) on the first reload.

import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const extension = join(packageRoot, "dist", "index.mjs");

function fakePi() {
  const tools = [];
  const handlers = new Map();
  return {
    tools,
    handlers,
    registerTool: (tool) => tools.push(tool.name),
    on: (event, handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
}

async function loadAs(source) {
  const factory = (await import(pathToFileURL(source).href)).default;
  const pi = fakePi();
  factory(pi);
  return pi;
}

// The copy must stay inside the package: the bundle keeps `typebox` and the pi
// packages external, so a copy elsewhere cannot resolve them.
function duplicateCopy(root) {
  const copy = join(root, "caveman-native.js");
  copyFileSync(extension, copy);
  return copy;
}

test("a duplicate Caveman copy registers nothing, and ctx.reload() re-registers the winner", async (t) => {
  // One claim lives on globalThis for the whole process, so this models both
  // load passes in a single test rather than letting a second test inherit one.
  const root = mkdtempSync(join(packageRoot, "node_modules", ".caveman-dup-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const copy = duplicateCopy(root);

  const winner = await loadAs(extension);
  const loser = await loadAs(copy);
  assert.deepEqual(winner.tools, ["caveman_retrieve"]);
  assert.deepEqual(loser.tools, [], "the duplicate must claim nothing pi would read as a conflict");
  assert.ok(winner.handlers.has("session_start"));
  assert.ok(!loser.handlers.has("session_start"));

  for (const handler of winner.handlers.get("session_shutdown") ?? []) {
    await handler({ type: "session_shutdown", reason: "reload" }, {});
  }

  const reloadedWinner = await loadAs(extension);
  const reloadedLoser = await loadAs(copy);
  assert.deepEqual(reloadedWinner.tools, ["caveman_retrieve"], "reload must re-register, not silently no-op");
  assert.ok(reloadedWinner.handlers.has("session_start"));
  assert.deepEqual(reloadedLoser.tools, []);
  assert.ok(!reloadedLoser.handlers.has("session_start"));
});