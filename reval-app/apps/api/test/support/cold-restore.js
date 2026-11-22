import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { setTimeout } from "node:timers/promises";
import { Binary, Decimal128, MongoClient, ObjectId } from "mongodb";
import { createApp } from "../../src/app.js";
import { migrate } from "../../src/database/bootstrap.js";
import {
  connectDatabase,
  isDatabaseReady,
} from "../../src/database/connection.js";
import { identityRouter } from "../../src/identity/routes.js";
import { identityStore, initializeIdentity } from "../../src/identity/store.js";

const mongod = process.env.REVAL_QA_MONGOD;
if (!mongod) throw Error("Set REVAL_QA_MONGOD to the local mongod executable.");
const root = await mkdtemp(join(tmpdir(), "reval-cold-drill-"));
const source = join(root, "source"),
  restored = join(root, "restored"),
  archive = join(root, "snapshot.tgz");
await mkdir(source);
await mkdir(restored);
const socket = createServer().listen(0, "127.0.0.1");
await once(socket, "listening");
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const name = "reval_test_cold";
const standalone = "mongodb://127.0.0.1:" + port + "/?directConnection=true";
const uri =
  "mongodb://127.0.0.1:" +
  port +
  "/" +
  name +
  "?replicaSet=coldDrill&directConnection=true";
const origin = "http://127.0.0.1:5173";
const user = "restore-admin",
  initial = randomBytes(20).toString("hex"),
  password = randomBytes(20).toString("hex");
const ids = {
  carton: new ObjectId().toString(),
  warehouse: new ObjectId().toString(),
  sku: new ObjectId().toString(),
  shipment: new ObjectId(),
  attachment: new ObjectId(),
};
const file = Buffer.from("%PDF-1.4\nsynthetic fixture for recovery\n%%EOF\n");
const sha = (value) => createHash("sha256").update(value).digest("hex");
let mongo;

async function start(folder, initialize) {
  mongo = spawn(
    mongod,
    [
      "--dbpath",
      folder,
      "--bind_ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--replSet",
      "coldDrill",
      "--logpath",
      join(root, basename(folder) + ".log"),
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  const client = new MongoClient(standalone, {
    serverSelectionTimeoutMS: 8000,
  });
  try {
    await client.connect();
    const admin = client.db("admin");
    if (initialize)
      await admin.command({
        replSetInitiate: {
          _id: "coldDrill",
          members: [{ _id: 0, host: "127.0.0.1:" + port }],
        },
      });
    for (let attempt = 0; attempt < 60; attempt++) {
      if ((await admin.command({ hello: 1 })).isWritablePrimary) return;
      await setTimeout(250);
    }
    throw Error("QA replica set did not elect a primary.");
  } finally {
    await client.close();
  }
}

async function stop() {
  if (!mongo || mongo.exitCode !== null || mongo.signalCode !== null) return;
  const exit = once(mongo, "exit", { signal: AbortSignal.timeout(15_000) });
  const client = new MongoClient(standalone, {
    serverSelectionTimeoutMS: 3000,
  });
  try {
    await client
      .db("admin")
      .command({ shutdown: 1, force: true, timeoutSecs: 0 });
  } catch (error) {
    // Shutdown can close the driver connection before an acknowledgement arrives.
    if (error.name === "MongoServerError") throw error;
  } finally {
    await client.close();
  }
  const [code] = await exit;
  assert.equal(
    code,
    0,
    "MongoDB must shut down cleanly before copying data files",
  );
}

async function tar(args) {
  const [code] = await once(
    spawn("tar", args, { stdio: "inherit", windowsHide: true }),
    "exit",
  );
  assert.equal(code, 0, "Snapshot archive command failed");
}

async function api(work, previous) {
  const database = await connectDatabase(uri);
  const from = (file) => pathToFileURL(join(previous, file)).href;
  const build = previous ? (await import(from("app.js"))).createApp : createApp;
  const router = previous
    ? (await import(from("identity/routes.js"))).identityRouter
    : identityRouter;
  const server = build({
    isReady: () => isDatabaseReady(database),
    identity: router(identityStore(database), { origin, ttl: 3600 }),
  }).listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const base = "http://127.0.0.1:" + server.address().port + "/api/v1";
    const call = (path, body, cookie) =>
      fetch(base + path, {
        method: body ? "POST" : "GET",
        headers: {
          Origin: origin,
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
    await work(database, call);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await database.close();
  }
}

try {
  await start(source, true);
  await api(async (database, call) => {
    await migrate(database);
    await initializeIdentity(identityStore(database), {
      REVAL_ADMIN_USERNAME: user,
      REVAL_ADMIN_PASSWORD: initial,
    });
    const login = await call("/auth/login", {
      username: user,
      password: initial,
    });
    assert.equal(login.status, 200);
    const change = await call(
      "/auth/password",
      { currentPassword: initial, newPassword: password },
      login.headers.get("set-cookie").split(";")[0],
    );
    assert.equal(change.status, 204);
    const at = new Date(),
      quantity = Decimal128.fromString("9.25"),
      scope = { warehouseId: ids.warehouse };
    await database.db.collection("reval_shipments").insertOne({
      _id: ids.shipment,
      code: "QA-RESTORE",
      scope,
      waybill: {
        fileId: String(ids.attachment),
        name: "fixture.pdf",
        size: file.length,
        contentType: "application/pdf",
      },
    });
    await database.db.collection("reval_file_assets").insertOne({
      _id: ids.attachment,
      shipmentId: String(ids.shipment),
      name: "fixture.pdf",
      type: "application/pdf",
      content: new Binary(file),
      checksum: sha(file),
      at,
    });
    await database.db.collection("reval_stock_balances").insertOne({
      _id: ids.carton,
      cartonId: ids.carton,
      warehouseId: ids.warehouse,
      skuId: ids.sku,
      scope,
      shipmentId: String(ids.shipment),
      account: "storage",
      locationId: null,
      quantity,
      reserved: Decimal128.fromString("0"),
      version: 0,
    });
    await database.db.collection("reval_stock_ledger").insertOne({
      _id: new ObjectId().toString(),
      documentType: "shipment.receipt",
      documentId: String(ids.shipment),
      cartonId: ids.carton,
      warehouseId: ids.warehouse,
      skuId: ids.sku,
      scope,
      from: "external",
      to: "storage",
      quantity,
      actorId: "qa-fixture",
      at,
    });
    await database.db
      .collection("reval_stock_ledger")
      .createIndex({ cartonId: 1 });
  });
  await stop();
  assert.equal((await stat(join(source, "mongod.lock"))).size, 0);
  const snapshotStart = performance.now();
  await tar(["-czf", archive, "-C", source, "."]);
  const snapshotMs = Math.round(performance.now() - snapshotStart);
  const size = (await stat(archive)).size;
  const expected = sha(await readFile(archive));
  const copy = join(root, "recovery.tgz");
  await cp(archive, copy, { errorOnExist: true, force: false });
  assert.equal(sha(await readFile(copy)), expected);
  const recoveryStart = performance.now();
  await tar(["-xzf", copy, "-C", restored]);
  await start(restored, false);
  async function verifyRecovery(database, call) {
    assert.equal((await call("/health/ready")).status, 200);
    const login = await call("/auth/login", { username: user, password });
    assert.equal(login.status, 200);
    assert.equal((await login.json()).result.mustChangePassword, false);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const attachment = await call(
      "/shipments/" + ids.shipment + "/waybill",
      undefined,
      cookie,
    );
    assert.equal(attachment.status, 200);
    assert.equal(sha(Buffer.from(await attachment.arrayBuffer())), sha(file));
    const response = await call(
      "/inventory/cartons/" + ids.carton + "/reconciliation",
      undefined,
      cookie,
    );
    assert.equal(response.status, 200);
    const result = (await response.json()).result;
    assert.deepEqual(
      [result.actual, result.expected, result.balanced],
      ["9.25", "9.25", true],
    );
    assert.ok(
      (await database.db.collection("reval_stock_ledger").indexes()).some(
        (index) => index.key.cartonId === 1,
      ),
    );
    await migrate(database);
    assert.equal(
      await database.db.collection("reval_schema_migrations").countDocuments(),
      1,
    );
  }
  await api(verifyRecovery);
  const recoveryMs = Math.round(performance.now() - recoveryStart);
  const previous = process.env.REVAL_QA_PREVIOUS_API;
  const rollbackStart = performance.now();
  if (previous) await api(verifyRecovery, previous);
  console.log(
    JSON.stringify({
      snapshotMs,
      size,
      recoveryMs,
      rollbackMs: previous
        ? Math.round(performance.now() - rollbackStart)
        : null,
      login: true,
      attachmentSha256: true,
      reconciliation: true,
      restoredIndex: true,
      migrationReplay: true,
    }),
  );
} finally {
  await stop();
  const target = await realpath(root);
  if (
    dirname(target) === (await realpath(tmpdir())) &&
    /^reval-cold-drill-[\w-]+$/.test(basename(target))
  )
    await rm(target, { recursive: true, force: true, maxRetries: 5 });
}
