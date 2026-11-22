import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { assertContractResponse } from "./support/release-contract.js";
import { createApp } from "../src/app.js";
import { readConfig, readIdentityOptions } from "../src/config.js";

test("validates configuration and keeps test data separate", () => {
  assert.throws(() => readConfig({}), /MONGODB_URI/);
  assert.throws(
    () => readConfig({ MONGODB_URI: "mongodb://localhost/reval_dev" }),
    /replicaSet/,
  );
  assert.throws(
    () =>
      readConfig({
        NODE_ENV: "test",
        MONGODB_URI: "mongodb://localhost/reval_dev?replicaSet=rs0",
      }),
    /namespace/,
  );
  assert.throws(
    () =>
      readConfig({
        NODE_ENV: "staging",
        MONGODB_URI:
          "mongodb://user:private@localhost/reval_staging?replicaSet=rs0",
        ALLOW_DEMO_SEED: "true",
      }),
    /Demo seed/,
  );
  assert.throws(
    () =>
      readConfig({
        NODE_ENV: "production",
        MONGODB_URI: "mongodb://user:private@localhost/reval?replicaSet=rs0",
        ALLOW_DEMO_SEED: "true",
      }),
    /Demo seed/,
  );
  assert.equal(
    readConfig({
      MONGODB_URI: "mongodb://localhost/reval_dev?replicaSet=rs0",
      PORT: "4200",
    }).port,
    4200,
  );
});

test("requires HTTPS for staging identity and retains a loopback development origin", () => {
  assert.throws(
    () =>
      readIdentityOptions({
        NODE_ENV: "staging",
        APP_ORIGIN: "http://127.0.0.1:8080",
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      readIdentityOptions({
        NODE_ENV: "production",
        APP_ORIGIN: "http://127.0.0.1:8080",
      }),
    /HTTPS/,
  );
  assert.equal(
    readIdentityOptions({
      NODE_ENV: "staging",
      APP_ORIGIN: "https://staging.example.invalid",
    }).origin,
    "https://staging.example.invalid",
  );
  assert.equal(
    readIdentityOptions({
      NODE_ENV: "development",
      APP_ORIGIN: "http://127.0.0.1:8080",
    }).origin,
    "http://127.0.0.1:8080",
  );
});

test("serves health and structured HTTP errors", async (t) => {
  let ready = false;
  const server = createApp({ isReady: async () => ready }).listen(
    0,
    "127.0.0.1",
  );
  t.after(
    () =>
      new Promise((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      ),
  );
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;

  const live = await fetch(`${base}/health/live`);
  assert.equal(live.status, 200);
  assertContractResponse(
    "GET",
    "/health/live",
    live.status,
    await live.clone().json(),
  );
  assert.equal((await live.json()).result.status, "live");
  const unavailable = await fetch(`${base}/health/ready`);
  assert.equal(unavailable.status, 503);
  assertContractResponse(
    "GET",
    "/health/ready",
    unavailable.status,
    await unavailable.clone().json(),
  );
  assert.equal((await unavailable.json()).code, "NOT_READY");
  ready = true;
  const healthy = await fetch(`${base}/health/ready`);
  assert.equal(healthy.status, 200);
  assert.equal((await healthy.json()).result.status, "ready");

  const missing = await fetch(`${base}/missing`);
  assert.equal(missing.status, 404);
  const error = await missing.json();
  assert.equal(error.code, "NOT_FOUND");
  assert.match(error.correlationId, /^[0-9a-f-]{36}$/);

  const invalid = await fetch(`${base}/missing`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, "INVALID_JSON");
});
