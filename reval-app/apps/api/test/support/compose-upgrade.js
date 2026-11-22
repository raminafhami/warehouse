import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  access,
  mkdtemp,
  writeFile,
  unlink,
  rmdir,
  realpath,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { prepareReceiptFixture } from "./receipt-fixture.js";

const previous = process.argv[2];
if (!previous || process.argv.length !== 3) {
  throw Error("Pass the path to the previous REVAL checkout.");
}
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const baselineRoot = await realpath(resolve(previous));
assert.notEqual(
  await realpath(root),
  baselineRoot,
  "Use a separate baseline checkout.",
);
await Promise.all(
  ["api.Dockerfile", "web.Dockerfile"].map((file) =>
    access(join(baselineRoot, "docker", file)),
  ),
);

function docker(args, env = process.env, capture = false) {
  return execFileSync("docker", args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    windowsHide: true,
  });
}

try {
  docker(["compose", "version"], process.env, true);
  docker(["info", "--format", "{{.ServerVersion}}"], process.env, true);
} catch {
  console.error("Docker Compose and a running Docker engine are required.");
  process.exit(1);
}

const socket = createServer().listen(0, "127.0.0.1");
await once(socket, "listening");
const { port } = socket.address();
await new Promise((done) => socket.close(done));

const secret = () => randomBytes(24).toString("hex");
const project = "reval-release-" + randomBytes(8).toString("hex");
const origin = "https://reval-release.example.invalid";
const username = "release-lab";
const initialPassword = secret();
const mongoImage = project + "/mongo:fixed";
const env = {
  ...process.env,
  APP_ORIGIN: origin,
  WEB_PORT: String(port),
  REVAL_IMAGE_PREFIX: project,
  REVAL_ADMIN_USERNAME: username,
  REVAL_ADMIN_PASSWORD: initialPassword,
  MONGO_ROOT_PASSWORD: secret(),
  MONGO_PASSWORD: secret(),
};
const temp = await mkdtemp(join(tmpdir(), project + "-"));
const override = join(temp, "mongo-image.json");
const envFile = join(temp, "empty.env");
let stackStarted = false;
const images = [];

function compose(tag, args, capture = false) {
  return docker(
    [
      "compose",
      "--project-name",
      project,
      "--env-file",
      envFile,
      "-f",
      "compose.yaml",
      "-f",
      "compose.staging.yaml",
      "-f",
      override,
      ...args,
    ],
    { ...env, REVAL_IMAGE_TAG: tag },
    capture,
  );
}

function build(context, service, image) {
  images.push(image);
  docker([
    "build",
    "-f",
    join(context, "docker", service + ".Dockerfile"),
    "-t",
    image,
    context,
  ]);
}

let cookie;
async function call(path, { body, idempotencyKey } = {}, expected = 200) {
  const response = await fetch("http://127.0.0.1:" + port + path, {
    method: body ? "POST" : "GET",
    headers: {
      Origin: origin,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, expected, path);
  return response;
}
async function result(path, options, expected) {
  return (await (await call("/api/v1" + path, options, expected)).json())
    .result;
}

async function switchImages(tag) {
  stackStarted = true;
  compose(tag, [
    "up",
    "--no-build",
    "--pull",
    "never",
    "--wait",
    "--wait-timeout",
    "150",
  ]);
  const ids = {};
  for (const service of ["mongo", "api", "web"]) {
    const id = compose(tag, ["ps", "-q", service], true).trim();
    assert.ok(id, service + " container is missing");
    const image =
      service === "mongo" ? mongoImage : project + "/" + service + ":" + tag;
    const inspect = (kind, format, name) =>
      docker(
        [kind, "inspect", "--format", format, name],
        process.env,
        true,
      ).trim();
    assert.equal(inspect("container", "{{.Config.Image}}", id), image);
    const imageId = inspect("container", "{{.Image}}", id);
    assert.equal(imageId, inspect("image", "{{.Id}}", image));
    ids[service] = { id, imageId };
  }
  const readiness = "http://127.0.0.1:" + port + "/api/v1/health/ready";
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(readiness, {
      signal: AbortSignal.timeout(2000),
    }).catch(() => null);
    await response?.text();
    if (response?.ok) break;
    assert.ok(attempt < 39, "Web proxy readiness timed out");
    await delay(250);
  }
  const html = await (await call("/")).text();
  const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  assert.ok(asset, "Web entry asset not found");
  const script = await call(asset);
  assert.match(script.headers.get("content-type") ?? "", /javascript/);
  await script.arrayBuffer();
  assert.equal((await result("/health/ready")).status, "ready");
  return ids;
}

try {
  await writeFile(
    override,
    JSON.stringify({ services: { mongo: { image: mongoImage } } }),
  );
  await writeFile(envFile, "");
  build(root, "mongo", mongoImage);
  for (const service of ["api", "web"]) {
    build(baselineRoot, service, project + "/" + service + ":previous");
    build(root, service, project + "/" + service + ":candidate");
  }
  const baseline = await switchImages("previous");
  const login = await call("/api/v1/auth/login", {
    body: { username, password: initialPassword },
  });
  const firstCookie = login.headers.getSetCookie()[0];
  assert.match(firstCookie, /; Secure(?:;|$)/i);
  cookie = firstCookie.split(";")[0];
  const rotation = await call(
    "/api/v1/auth/password",
    { body: { currentPassword: initialPassword, newPassword: secret() } },
    204,
  );
  cookie = rotation.headers.getSetCookie()[0].split(";")[0];
  const fixture = await prepareReceiptFixture(result);
  const earlier = await fixture.receive(80);

  const candidate = await switchImages("candidate");
  assert.deepEqual(candidate.mongo, baseline.mongo);
  assert.notEqual(candidate.api.id, baseline.api.id);
  assert.notEqual(candidate.web.id, baseline.web.id);
  await earlier.verify();
  const later = await fixture.receive(81);

  const restored = await switchImages("previous");
  assert.deepEqual(restored.mongo, baseline.mongo);
  for (const service of ["api", "web"]) {
    assert.equal(restored[service].imageId, baseline[service].imageId);
    assert.notEqual(restored[service].id, candidate[service].id);
  }
  await earlier.replay();
  await later.replay();
  console.log(
    JSON.stringify({
      result: "PASS",
      previous: { api: baseline.api.imageId, web: baseline.web.imageId },
      candidate: { api: candidate.api.imageId, web: candidate.web.imageId },
      mongo: baseline.mongo.imageId,
    }),
  );
} finally {
  try {
    if (stackStarted)
      compose("previous", ["down", "--volumes", "--remove-orphans"]);
  } finally {
    if (images.length)
      spawnSync("docker", ["image", "rm", ...images], {
        stdio: "ignore",
        windowsHide: true,
      });
    await Promise.allSettled([unlink(override), unlink(envFile)]);
    await rmdir(temp);
  }
}
