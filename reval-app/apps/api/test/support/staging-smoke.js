import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { request as forward } from "node:http";
import {
  createServer as secureServer,
  request as tlsRequest,
} from "node:https";
import { createServer as tcpServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MongoClient } from "mongodb";
import { prepareReceiptFixture } from "./receipt-fixture.js";

const mongod = process.env.REVAL_QA_MONGOD;
const openssl = process.env.REVAL_QA_OPENSSL ?? "openssl";
if (!mongod) throw Error("Set REVAL_QA_MONGOD to the local mongod executable.");
const binary = fileURLToPath(new URL("../../src/server.js", import.meta.url));
const web = fileURLToPath(new URL("../../../web/dist/", import.meta.url));
const index = await readFile(join(web, "index.html"), "utf8");
const root = await mkdtemp(join(tmpdir(), "reval-staging-lab-"));
const data = join(root, "data"),
  key = join(root, "cluster.key");
const ca = join(root, "tls.crt"),
  privateKey = join(root, "tls.key");
const password = () => randomBytes(32).toString("hex");
const rootSecret = password(),
  mongoSecret = password(),
  initial = password(),
  replacement = password();
const database = "reval_staging";
let mongo, api, proxy;

async function ephemeral() {
  const server = tcpServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

const mongoPort = await ephemeral(),
  apiPort = await ephemeral();
const socket = "mongodb://127.0.0.1:" + mongoPort;
const params = "?replicaSet=stagingLab&directConnection=true";
const adminUri =
  "mongodb://lab_admin:" +
  rootSecret +
  "@127.0.0.1:" +
  mongoPort +
  "/admin" +
  params;
const appUri =
  "mongodb://reval_app:" +
  mongoSecret +
  "@127.0.0.1:" +
  mongoPort +
  "/" +
  database +
  params;

async function stop(child, graceful = false) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit", { signal: AbortSignal.timeout(15_000) });
  child.kill(graceful ? "SIGTERM" : "SIGKILL");
  await exited;
}

async function startMongo(authenticated) {
  mongo = spawn(
    mongod,
    [
      "--dbpath",
      data,
      "--bind_ip",
      "127.0.0.1",
      "--port",
      String(mongoPort),
      "--replSet",
      "stagingLab",
      "--logappend",
      "--logpath",
      join(root, "mongo.log"),
      ...(authenticated ? ["--keyFile", key] : []),
    ],
    { stdio: "ignore", windowsHide: true },
  );
  await once(mongo, "spawn");
  const client = new MongoClient(
    authenticated ? adminUri : socket + "/?directConnection=true",
    { serverSelectionTimeoutMS: 8000 },
  );
  try {
    await client.connect();
    const admin = client.db("admin");
    if (!authenticated)
      await admin.command({
        replSetInitiate: {
          _id: "stagingLab",
          members: [{ _id: 0, host: "127.0.0.1:" + mongoPort }],
        },
      });
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await admin.command({ hello: 1 })).isWritablePrimary) return client;
      await setTimeout(250);
    }
    throw Error("Lab MongoDB did not elect a primary.");
  } catch (error) {
    await client.close();
    throw error;
  }
}

async function shutdownMongo(client) {
  const exited = once(mongo, "exit", { signal: AbortSignal.timeout(15000) });
  try {
    await client
      .db("admin")
      .command(
        { shutdown: 1, force: true, timeoutSecs: 0 },
        { timeoutMS: 3000 },
      );
  } catch (error) {
    if (error.name === "MongoServerError") throw error;
  }
  const [code] = await exited;
  assert.equal(code, 0);
}

try {
  await mkdir(data);
  await writeFile(key, randomBytes(72).toString("base64"), { mode: 0o600 });
  await promisify(execFile)(
    openssl,
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=REVAL staging lab",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      privateKey,
      "-out",
      ca,
    ],
    { windowsHide: true },
  );
  const bootstrap = await startMongo(false);
  try {
    await bootstrap
      .db("admin")
      .command({ createUser: "lab_admin", pwd: rootSecret, roles: ["root"] });
    await bootstrap.db(database).command({
      createUser: "reval_app",
      pwd: mongoSecret,
      roles: ["readWrite"],
    });
    await shutdownMongo(bootstrap);
  } finally {
    await bootstrap.close();
  }
  const administrator = await startMongo(true);
  await administrator.close();
  const anonymous = new MongoClient(
    socket + "/" + database + "?directConnection=true",
    { serverSelectionTimeoutMS: 3000 },
  );
  try {
    await assert.rejects(
      anonymous.db(database).command({ find: "reval_users" }),
      (error) => error.code === 13,
    );
  } finally {
    await anonymous.close();
  }

  const certificate = await readFile(ca);
  proxy = secureServer(
    {
      key: await readFile(privateKey),
      cert: certificate,
      minVersion: "TLSv1.2",
    },
    (req, res) => {
      const pathname = new URL(req.url, "https://localhost").pathname;
      if (pathname.startsWith("/api/")) {
        const upstream = forward(
          {
            host: "127.0.0.1",
            port: apiPort,
            path: req.url,
            method: req.method,
            headers: { ...req.headers, "x-forwarded-proto": "https" },
          },
          (reply) => {
            res.writeHead(reply.statusCode, reply.headers);
            reply.pipe(res);
          },
        );
        upstream.on("error", () => {
          res.writeHead(502);
          res.end();
        });
        req.pipe(upstream);
        return;
      }
      if (pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(index);
      }
      if (/^\/assets\/[A-Za-z0-9_-]+\.(js|css)$/.test(pathname)) {
        readFile(join(web, pathname.slice(1)))
          .then((asset) => {
            res.writeHead(200, {
              "Content-Type": pathname.endsWith(".js")
                ? "text/javascript"
                : "text/css",
            });
            res.end(asset);
          })
          .catch(() => {
            res.writeHead(404);
            res.end();
          });
        return;
      }
      res.writeHead(404);
      res.end();
    },
  ).listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const origin = "https://127.0.0.1:" + proxy.address().port;

  function launch() {
    api = spawn(process.execPath, [binary], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "inherit"],
      env: {
        ...process.env,
        NODE_ENV: "staging",
        HOST: "127.0.0.1",
        PORT: String(apiPort),
        APP_ORIGIN: origin,
        MONGODB_URI: appUri,
        REVAL_ADMIN_USERNAME: "staging-lab",
        REVAL_ADMIN_PASSWORD: initial,
        ALLOW_DEMO_SEED: "false",
      },
    });
  }

  function call(
    path,
    { body, cookie, idempotencyKey, requestOrigin = origin } = {},
  ) {
    return new Promise((resolve, reject) => {
      const req = tlsRequest(
        origin + path,
        {
          method: body ? "POST" : "GET",
          ca: certificate,
          headers: {
            Origin: requestOrigin,
            ...(body ? { "Content-Type": "application/json" } : {}),
            ...(cookie ? { Cookie: cookie } : {}),
            ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
          },
        },
        (res) => {
          const data = [];
          res.on("data", (chunk) => data.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              text: Buffer.concat(data).toString("utf8"),
            }),
          );
        },
      );
      req.setTimeout(5000, () =>
        req.destroy(Error("TLS smoke call timed out")),
      );
      req.on("error", reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  }

  async function ready() {
    for (let attempt = 0; attempt < 40; attempt++) {
      const result = await call("/api/v1/health/ready");
      if (result.status === 200) return;
      if (api.exitCode !== null)
        throw Error("Staging API exited during startup.");
      await setTimeout(250);
    }
    throw Error("Staging readiness timed out.");
  }

  launch();
  await ready();
  const html = await call("/");
  assert.equal(html.status, 200);
  const asset = html.text.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  assert.ok(asset);
  assert.equal((await call(asset)).status, 200);
  assert.equal((await call("/api/v1/health/live")).status, 200);
  assert.equal((await call("/api/v1/auth/session")).status, 401);
  assert.equal(
    (
      await call("/api/v1/auth/login", {
        requestOrigin: "https://elsewhere.invalid",
        body: { username: "staging-lab", password: initial },
      })
    ).status,
    403,
  );
  const login = await call("/api/v1/auth/login", {
    body: { username: "staging-lab", password: initial },
  });
  assert.equal(login.status, 200);
  const first = login.headers["set-cookie"][0];
  for (const bit of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/api/v1"])
    assert.ok(first.includes(bit));
  const change = await call("/api/v1/auth/password", {
    cookie: first.split(";")[0],
    body: { currentPassword: initial, newPassword: replacement },
  });
  assert.equal(change.status, 204);
  const cookie = change.headers["set-cookie"][0].split(";")[0];
  assert.equal((await call("/api/v1/auth/session", { cookie })).status, 200);
  const audit = await call("/api/v1/audit?module=auth");
  assert.equal(audit.status, 401);
  const signedAudit = await call("/api/v1/audit?module=auth", { cookie });
  assert.equal(signedAudit.status, 200);
  assert.ok(JSON.parse(signedAudit.text).result.count >= 2);

  async function result(path, options = {}, expected = 200) {
    const response = await call("/api/v1" + path, {
      cookie,
      ...options,
    });
    assert.equal(response.status, expected);
    return JSON.parse(response.text).result;
  }
  const { warehouseId, receive } = await prepareReceiptFixture(result);
  const receipt = await receive(80);

  const readerPassword = password();
  await result(
    "/users",
    {
      body: {
        name: "Staging lab reader",
        username: "lab-reader",
        password: readerPassword,
        roleId: "whOperator",
        organizationWide: false,
        scopes: [{ warehouseId }],
      },
    },
    201,
  );
  await stop(api, true);
  launch();
  await ready();
  assert.equal((await call("/api/v1/auth/session", { cookie })).status, 200);
  const readerLogin = await call("/api/v1/auth/login", {
    body: { username: "lab-reader", password: readerPassword },
  });
  assert.equal(readerLogin.status, 200);
  const readerRotation = await call("/api/v1/auth/password", {
    cookie: readerLogin.headers["set-cookie"][0].split(";")[0],
    body: { currentPassword: readerPassword, newPassword: password() },
  });
  assert.equal(readerRotation.status, 204);
  const reader = readerRotation.headers["set-cookie"][0].split(";")[0];
  assert.notEqual(reader, cookie);
  await receipt.verify({ cookie: reader });
  const laterReceipt = await receive(81);
  const appDb = new MongoClient(appUri);
  try {
    assert.equal(
      await appDb
        .db(database)
        .collection("reval_demo_metadata")
        .countDocuments(),
      0,
    );
    assert.equal(
      await appDb
        .db(database)
        .collection("reval_schema_migrations")
        .countDocuments(),
      1,
    );
  } finally {
    await appDb.close();
  }
  const maintenance = new MongoClient(adminUri, {
    serverSelectionTimeoutMS: 3000,
  });
  try {
    await shutdownMongo(maintenance);
  } finally {
    await maintenance.close();
  }
  const outage = await call("/api/v1/health/ready");
  assert.equal(outage.status, 503);
  assert.equal(JSON.parse(outage.text).code, "NOT_READY");
  assert.equal((await call("/api/v1/health/live")).status, 200);
  const restarted = await startMongo(true);
  await restarted.close();
  await ready();
  assert.equal((await call("/api/v1/auth/session", { cookie })).status, 200);
  await receipt.verify({ cookie: reader });
  await laterReceipt.verify({ cookie: reader });
  await receipt.replay();
  await laterReceipt.replay();
  console.log(
    "Staging lab PASS: TLS, role-scoped independent session, receipt and stock persistence after API and MongoDB restarts, receipt replay, audit, and demo isolation.",
  );
} finally {
  if (proxy) {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
  }
  await stop(api, true);
  await stop(mongo);
  const resolved = await realpath(root);
  if (
    dirname(resolved) === (await realpath(tmpdir())) &&
    /^reval-staging-lab-[\w-]+$/.test(basename(resolved))
  )
    await rm(resolved, { recursive: true, force: true, maxRetries: 5 });
}
