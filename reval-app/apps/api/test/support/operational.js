import { UUID } from "mongodb";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const childPath = fileURLToPath(
  new URL("./operational-child.js", import.meta.url),
);

export function baselineClients() {
  if (process.env.REVAL_P14_BASELINE !== "true") return 0;
  const clients = Number(process.env.REVAL_P14_CLIENTS ?? "16");
  assert.ok(
    Number.isInteger(clients) && clients >= 1 && clients <= 64,
    "REVAL_P14_CLIENTS must be an integer between 1 and 64.",
  );
  return clients;
}

/** @param {string} uri @param {string} origin */
async function open(uri, origin) {
  const child = fork(childPath, [], {
    execArgv: [],
    env: {
      ...process.env,
      REVAL_TEST_CHILD_URI: uri,
      REVAL_TEST_CHILD_ORIGIN: origin,
    },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    windowsHide: true,
  });
  const initial = await Promise.race([
    once(child, "message").then(([message]) => message),
    once(child, "exit").then(([code]) => {
      throw Error("QA API exited before readiness: " + code);
    }),
  ]);
  assert.equal(typeof initial.port, "number");
  return { child, base: "http://127.0.0.1:" + initial.port + "/api/v1" };
}
/** @param {import('node:child_process').ChildProcess} child */
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}
/** @param {import("node:child_process").ChildProcess} child */
async function sampleApi(child) {
  const answer = once(child, "message", {
    signal: AbortSignal.timeout(15_000),
  });
  child.send("sample");
  return (await answer)[0];
}
/** @param {{uri:string,origin:string,admin:string,operator:string,carton:object,phoneCode:string,samplePhones:string[],db:import('mongoose').Connection}} options */
export async function verifyRestartAndLoad({
  uri,
  origin,
  admin,
  operator,
  carton,
  phoneCode,
  samplePhones,
  db,
}) {
  let server = await open(uri, origin);
  const idempotency = randomUUID();
  /** @param {string} path @param {string} cookie @param {object} [body] @param {string} [key] */
  const call = (path, cookie, body, key) =>
    fetch(server.base + path, {
      method: body ? "POST" : "GET",
      headers: {
        Origin: origin,
        Cookie: cookie,
        ...(body
          ? {
              "Content-Type": "application/json",
              "Idempotency-Key": key ?? randomUUID(),
            }
          : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  try {
    const created = await call(
      "/finished/cartons",
      operator,
      carton,
      idempotency,
    );
    assert.equal(created.status, 201);
    const original = (await created.json()).result;
    await db.createCollection("reval_test_crash");
    const staged = once(server.child, "message", {
      signal: AbortSignal.timeout(15_000),
    });
    server.child.send("hold");
    const [pending] = await staged;
    assert.equal(pending.event, "staged");
    await stop(server.child);
    assert.equal(await db.collection("reval_test_crash").countDocuments(), 0);
    await db.db.admin().command({
      killSessions: [{ id: UUID.createFromHexString(pending.id) }],
    });
    server = await open(uri, origin);
    const replay = await call(
      "/finished/cartons",
      operator,
      carton,
      idempotency,
    );
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).result.id, original.id);
    const mismatch = await call(
      "/finished/cartons",
      operator,
      { ...carton, colorId: "000000000000000000000001" },
      idempotency,
    );
    assert.equal(mismatch.status, 409);
    const records = db.collection("reval_finished_cartons");
    assert.equal(await records.countDocuments({ code: original.code }), 1);
    const committedActions = db.collection("reval_audit");
    assert.equal(
      await committedActions.countDocuments({
        entityId: original.id,
        result: "success",
        action: "finished.create",
      }),
      1,
    );

    const clients = samplePhones.length,
      rounds = 12;
    if (!clients) return;
    const targets = [];
    for (const code of samplePhones) {
      const reply = await call("/finished/cartons", operator, carton);
      assert.equal(reply.status, 201);
      targets.push({ id: (await reply.json()).result.id, code });
    }
    const cpuStart = await sampleApi(server.child);
    const started = performance.now();
    const timings = await Promise.all(
      Array.from({ length: clients }, (_, worker) => run(worker)),
    );
    const elapsedMs = performance.now() - started;
    const samples = timings.flat();
    const summary = Object.fromEntries(
      ["dashboard", "reports", "trace", "scan-reject", "retry", "scan-ok"].map(
        (name) => {
          const rows = samples.filter((row) => row.name === name);
          const sorted = rows.map((row) => row.latency).sort((a, b) => a - b);
          return [
            name,
            {
              requests: rows.length,
              p95Ms: Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1]),
              unexpected: rows.filter((row) => !row.ok).length,
            },
          ];
        },
      ),
    );
    const usage = await sampleApi(server.child);
    for (const target of targets)
      assert.equal(
        await records.countDocuments({ "members.numbers": target.code }),
        1,
      );
    assert.ok(samples.every((row) => row.ok));
    const reconciled = await call("/reports?kind=ledger", admin);
    assert.equal(reconciled.status, 200);
    assert.ok(
      (await reconciled.json()).result.snapshot.every(
        (/** @type {{balanced:boolean}} */ row) => row.balanced,
      ),
    );
    assert.equal(await records.countDocuments({ code: original.code }), 1);
    const mongoStats = await db.db.admin().command({ serverStatus: 1 });
    console.info(
      "P14_BASELINE " +
        JSON.stringify({
          clients,
          rounds,
          requests: samples.length,
          elapsedMs: Math.round(elapsedMs),
          summary,
          apiRssMiB: Math.round(usage.rss / 1048576),
          apiCpuMs: Math.round(
            (usage.cpu.user +
              usage.cpu.system -
              cpuStart.cpu.user -
              cpuStart.cpu.system) /
              1000,
          ),
          mongoRssMiB: mongoStats.mem?.resident,
        }),
    );

    /** @param {number} worker */
    async function run(worker) {
      const startedScan = performance.now();
      const write = await call(
        "/finished/cartons/" + targets[worker].id + "/scan",
        operator,
        { version: 1, code: targets[worker].code },
      );
      await write.arrayBuffer();
      const rows = [
        {
          name: "scan-ok",
          latency: performance.now() - startedScan,
          ok: write.status === 201,
        },
      ];
      for (let round = 1; round < rounds; round++) {
        const mode = (worker + round) % 5;
        const started = performance.now();
        const name = ["dashboard", "reports", "trace", "scan-reject", "retry"][
          mode
        ];
        const response =
          mode === 0
            ? await call("/dashboard", admin)
            : mode === 1
              ? await call("/reports?kind=ledger", admin)
              : mode === 2
                ? await call("/trace?kind=units&q=" + phoneCode, admin)
                : mode === 3
                  ? await call(
                      "/finished/cartons/" + original.id + "/scan",
                      operator,
                      { version: 1, code: phoneCode },
                    )
                  : await call(
                      "/finished/cartons",
                      operator,
                      carton,
                      idempotency,
                    );
        await response.arrayBuffer();
        rows.push({
          name,
          latency: performance.now() - started,
          ok: response.status === (mode === 3 ? 409 : 200),
        });
      }
      return rows;
    }
  } finally {
    await stop(server.child);
  }
}
