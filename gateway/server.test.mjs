import test from "node:test";
import assert from "node:assert/strict";

test("gateway source exists and is an ES module", async () => {
  const module = await import("./server.mjs");
  assert.ok(module.server);
  await new Promise((resolve) => module.server.listen(0, "127.0.0.1", resolve));
  const port = module.server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, "GATEWAY_NOT_CONFIGURED");
  await new Promise((resolve) => module.server.close(resolve));
});

