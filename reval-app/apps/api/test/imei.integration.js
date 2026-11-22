import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { ObjectId } from "mongodb";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { catalogStore, initializeCatalog } from "../src/catalog/store.js";
import { readConfig } from "../src/config.js";
import { connectDatabase } from "../src/database/connection.js";
import { imeiStore, initializeImei } from "../src/imei/store.js";
import { recordMilestone } from "../src/imei/orders.js";
import { identityRouter } from "../src/identity/routes.js";
import { identityStore, initializeIdentity } from "../src/identity/store.js";

test("IMEI import, production snapshots, concurrent allocation, correction and manual Hamta", async () => {
  const source = readConfig({
    NODE_ENV: "test",
    MONGODB_URI: process.env.TEST_MONGODB_URI,
  });
  const namespace = "reval_test_" + randomBytes(8).toString("hex");
  const uri = source.uri.replace(
    /\/reval_test(?:_[a-z0-9]+)?(?=\?)/,
    "/" + namespace,
  );
  assert.notEqual(uri, source.uri);
  const database = await connectDatabase(uri);
  const identity = identityStore(database),
    store = imeiStore(database);
  const origin = "http://127.0.0.1:5173";
  const secret = () => randomBytes(18).toString("hex");
  const initial = secret();
  const server = createApp({
    isReady: async () => true,
    identity: identityRouter(identity, { origin, ttl: 3600 }),
  }).listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    await initializeIdentity(identity, {
      REVAL_ADMIN_USERNAME: "imei-admin",
      REVAL_ADMIN_PASSWORD: initial,
    });
    await initializeCatalog(catalogStore(database));
    await initializeImei(store);
    const base = "http://127.0.0.1:" + server.address().port + "/api/v1";
    let admin;
    async function call(
      path,
      method = "GET",
      body,
      cookie = admin,
      key = secret(),
    ) {
      const response = await fetch(base + path, {
        method,
        headers: {
          Origin: origin,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body
            ? { "Content-Type": "application/json", "Idempotency-Key": key }
            : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = response.status === 204 ? null : await response.json();
      return {
        status: response.status,
        data: data?.result,
        error: data,
        cookie: response.headers.get("set-cookie")?.split(";")[0],
      };
    }
    async function success(promise, status = 201) {
      const result = await promise;
      assert.equal(result.status, status, JSON.stringify(result.error));
      return result.data;
    }
    async function login(username, password) {
      const first = await call(
        "/auth/login",
        "POST",
        { username, password },
        null,
      );
      assert.equal(first.status, 200);
      const next = await call(
        "/auth/password",
        "POST",
        { currentPassword: password, newPassword: secret() },
        first.cookie,
      );
      assert.equal(next.status, 204);
      return next.cookie;
    }
    admin = await login("imei-admin", initial);
    const add = (kind, code, data = {}, parentId) =>
      success(
        call("/master/" + kind, "POST", { code, name: code, data, parentId }),
      );
    const unit = await add("units", "PCS");
    const type = await add("partTypes", "BAT", { unitId: unit.id });
    const supplier = await add("suppliers", "SUP-A");
    const sku = await add("skus", "BAT-01", {
      partTypeId: type.id,
      supplierId: supplier.id,
      specification: "4V",
    });
    const branch = await add("branches", "BR-A");
    const line = await add("lines", "L-1", {}, branch.id);
    const otherLine = await add("lines", "L-2", {}, branch.id);
    const station = await add("stations", "ST-1", { order: 1 }, line.id);
    const color = await add("colors", "BLK");
    const model = await add("models", "TA-130", {
      colorIds: [color.id],
      imeiSlots: 2,
    });
    const addBom = (quantity) =>
      success(
        call("/master/versions", "POST", {
          type: "bom",
          modelId: model.id,
          lines: [{ skuId: sku.id, quantity, stationCode: station.code }],
        }),
      );
    const firstBom = await addBom("2");

    const route = (stationIds) =>
      success(
        call("/master/versions", "POST", {
          type: "routing",
          modelId: model.id,
          lineId: line.id,
          stationIds,
        }),
      );
    const orderInput = {
      modelId: model.id,
      colorId: color.id,
      lineId: line.id,
      count: 1,
    };
    const createOrder = (input = orderInput, cookie = admin, key = secret()) =>
      call("/imei/orders", "POST", input, cookie, key);
    assert.equal((await createOrder()).status, 409);
    const firstRoute = await route([station.id]);
    const unavailableColor = await add("colors", "RED");
    assert.equal(
      (await createOrder({ ...orderInput, colorId: unavailableColor.id }))
        .status,
      409,
    );
    const createActor = async (name, roleId, scope) => {
      const password = secret();
      await success(
        call("/users", "POST", {
          username: name,
          name,
          password,
          roleId,
          organizationWide: false,
          scopes: [scope],
        }),
      );
      return login(name, password);
    };
    const manager = await createActor("line-manager", "productionManager", {
      lineId: line.id,
    });
    const managerElsewhere = await createActor(
      "other-manager",
      "productionManager",
      { lineId: otherLine.id },
    );
    const qc = await createActor("line-qc", "qcManager", { lineId: line.id });
    const order = await success(createOrder(orderInput, manager, "order-1"));
    assert.equal(order.bomVersionId, firstBom.id);
    assert.equal(order.routingVersionId, firstRoute.id);
    assert.equal(
      (await success(createOrder(orderInput, manager, "order-1"), 200)).id,
      order.id,
    );
    assert.equal((await createOrder(orderInput, managerElsewhere)).status, 403);
    assert.equal(
      (
        await call(
          "/imei/orders/" + order.id,
          "GET",
          undefined,
          managerElsewhere,
        )
      ).status,
      403,
    );
    const nextStation = await add("stations", "ST-2", { order: 2 }, line.id);
    const nextRoute = await route([station.id, nextStation.id]);
    const nextBom = await addBom("3");
    const otherOrder = await success(createOrder());
    assert.equal(otherOrder.bomVersionId, nextBom.id);
    assert.equal(otherOrder.routingVersionId, nextRoute.id);
    const getOrder = async (id) =>
      (await success(call("/imei/orders/" + id), 200)).order;
    assert.equal((await getOrder(order.id)).routingVersionId, firstRoute.id);

    const single = await add("models", "TA-140", {
      colorIds: [color.id],
      imeiSlots: 1,
    });
    const importFile = (modelId, rows, key = secret(), cookie = admin) =>
      call(
        "/imei/imports",
        "POST",
        {
          modelId,
          source: "fixture.csv",
          rows: rows.map((cells, index) => ({ row: index + 2, cells })),
        },
        cookie,
        key,
      );
    const number = (index) => {
      const digits = "00990000" + String(index).padStart(6, "0");
      return (
        digits +
        [..."0123456789"].find(
          (check) =>
            [...(digits + check)].reduce((sum, digit, position) => {
              const n = Number(digit) * (position % 2 ? 2 : 1);
              return sum + (n > 9 ? n - 9 : n);
            }, 0) %
              10 ===
            0,
        )
      );
    };
    const [a, b, c, d, e, f, g, h, i, j, k] = Array.from(
      { length: 12 },
      (_, index) => number(index + 1),
    );
    const translated = a
      .split("")
      .map((digit, index) =>
        String.fromCharCode((index % 2 ? 0x660 : 0x6f0) + Number(digit)),
      )
      .join("");
    const normalizedWithSeparator =
      translated.slice(0, 5) + " - " + translated.slice(5);
    const testRows = [
      [normalizedWithSeparator, b],
      ["123", c],
      [a, c],
      [c, c],
      [d],
      [d.slice(0, -1) + String((Number(d.at(-1)) + 1) % 10), e],
    ];
    assert.equal(
      (await importFile(model.id, testRows, "line", manager)).status,
      403,
    );
    const importResponse = await success(
      importFile(model.id, testRows, "import-1"),
    );
    assert.equal(importResponse.accepted, 1);
    assert.deepEqual(
      importResponse.errors.map(({ row, code }) => [row, code]),
      [
        [3, "CHECK_DIGIT"],
        [4, "DUPLICATE"],
        [5, "SAME_PAIR"],
        [6, "SLOTS"],
        [7, "CHECK_DIGIT"],
      ],
    );
    assert.equal(
      (await success(importFile(model.id, testRows, "import-1"), 200)).id,
      importResponse.id,
    );
    assert.deepEqual((await store.pairs.findOne({})).numbers, [a, b]);
    const imports = await Promise.all([
      importFile(model.id, [[c, d]]),
      importFile(single.id, [[d]]),
    ]);
    assert.ok(
      imports.every((result) => result.status === 201),
      JSON.stringify(imports),
    );
    assert.deepEqual(
      imports.map((result) => result.data.accepted).sort(),
      [0, 1],
    );
    assert.equal(
      imports.find((result) => !result.data.accepted).data.errors[0].code,
      "DUPLICATE",
    );
    assert.equal(await store.pairs.countDocuments({ numbers: d }), 1);
    const addSingle = await success(importFile(single.id, [[b], [k]]));
    assert.equal(addSingle.accepted, 1);
    assert.equal(addSingle.errors[0].code, "DUPLICATE");
    const pool = (query = "", cookie = admin) =>
      success(call("/imei/pool" + query, "GET", undefined, cookie), 200);
    assert.equal(
      (await pool("?q=" + encodeURIComponent(normalizedWithSeparator))).data[0]
        .numbers[0],
      a,
    );
    assert.equal((await pool("?status=free", manager)).count, 0);
    assert.equal((await pool("?size=1&page=0")).data.length, 1);
    assert.equal(
      (await call("/imei/imports", "GET", undefined, manager)).status,
      403,
    );
    assert.equal(
      (await call("/imei/pool/export", "GET", undefined, qc)).status,
      403,
    );
    assert.equal((await call("/imei/pool/export")).status, 200);
    assert.equal(
      (await call("/imei/hamta/simulate", "POST", { outcome: "activated" }))
        .status,
      404,
    );

    const allocate = (id, key, cookie = manager) =>
      call("/imei/orders/" + id + "/units", "POST", {}, cookie, key);
    const attempts = await Promise.all([
      allocate(order.id, "alloc-a"),
      allocate(order.id, "alloc-b"),
    ]);
    assert.deepEqual(
      attempts.map((result) => result.status).sort(),
      [201, 409],
    );
    const first = attempts.find((result) => result.status === 201).data;
    assert.deepEqual(first.numbers, [a, b]);
    assert.equal((await getOrder(order.id)).allocated, 1);
    assert.equal((await pool("?status=allocated", manager)).count, 1);
    assert.equal((await pool("?status=allocated", managerElsewhere)).count, 0);
    const unitOp = (
      unit,
      action,
      body = {},
      cookie = manager,
      key = secret(),
    ) =>
      call(
        "/imei/units/" + unit.id + "/" + action,
        "POST",
        { version: unit.version, ...body },
        cookie,
        key,
      );
    assert.equal(
      (await unitOp(first, "void", { reason: "QC" }, qc)).status,
      409,
    );
    assert.equal((await unitOp(first, "release")).status, 400);
    const released = await success(
      unitOp(first, "release", { reason: "Cancelled before print" }),
    );
    assert.equal(released.state, "released");
    assert.equal((await getOrder(order.id)).allocated, 0);
    assert.equal((await pool("?q=" + a)).data[0].status, "free");
    const scoped = await Promise.all([
      allocate(order.id, "same-key"),
      allocate(order.id, "same-key"),
    ]);
    assert.deepEqual(scoped.map((result) => result.status).sort(), [200, 201]);
    assert.equal(scoped[0].data.id, scoped[1].data.id);
    let phone = scoped[0].data;
    const sendHamta = (
      entries,
      action = "submit",
      cookie = qc,
      key = secret(),
    ) => call("/imei/hamta/results", "POST", { action, entries }, cookie, key);
    const entry = (unit, outcome, extras = {}) => ({
      id: unit.id,
      version: unit.version,
      outcome,
      ...extras,
    });
    assert.equal(
      (
        await sendHamta([
          entry(phone, "activated", { trackingCode: "TEST-OFFICIAL-EXAMPLE" }),
        ])
      ).status,
      409,
    );
    const recordedError = await success(
      unitOp(phone, "error", { reason: "Scan mismatch" }, qc),
    );
    assert.equal((await pool("?status=error")).count, 1);
    const mark = (unit, mark) =>
      database.transaction(async (session) => {
        const current = await store.units.findOne(
          { _id: new ObjectId(unit.id) },
          { session },
        );
        return recordMilestone(store, current, mark, "test-workflow", session);
      });
    await assert.rejects(mark(recordedError, "printed"), {
      code: "IMEI_CONFLICT",
    });
    // Free the unprinted pair, then exercise void/replacement on a clean allocation.
    await success(
      unitOp(recordedError, "release", {
        reason: "Duplicate physical label was avoided",
      }),
    );
    phone = await success(allocate(order.id));
    phone = await mark(phone, "printed");
    assert.equal(
      (await unitOp(phone, "release", { reason: "Already printed" })).status,
      409,
    );
    assert.equal(
      (await unitOp(phone, "void", { reason: "Wrong label" })).status,
      403,
    );
    phone = await mark(phone, "final-qc");
    const obsolete = await success(
      unitOp(phone, "void", { reason: "Label damaged before Hamta" }, qc),
    );
    assert.equal((await pool("?q=" + a)).data[0].status, "void");
    assert.equal((await getOrder(order.id)).replacementDue, 1);
    assert.equal((await allocate(order.id)).status, 409);
    await success(
      importFile(model.id, [
        [e, f],
        [g, h],
        [i, j],
      ]),
    );
    phone = await success(unitOp(obsolete, "replace"));
    assert.equal(phone.id, obsolete.id);
    assert.notDeepEqual(phone.numbers, obsolete.numbers);
    assert.equal((await getOrder(order.id)).replacementDue, 0);
    phone = await mark(await mark(phone, "printed"), "final-qc");
    let another = await success(allocate(otherOrder.id));
    another = await mark(await mark(another, "printed"), "final-qc");
    assert.equal((await sendHamta([entry(phone, "activated")])).status, 400);
    const attemptedBatch = await sendHamta([
      entry(phone, "submitted", { reason: "External response unknown" }),
      entry(another, "activated"),
    ]);
    assert.equal(attemptedBatch.status, 400);
    assert.equal(
      (await store.units.findOne({ _id: new ObjectId(phone.id) })).hamtaStatus,
      "pending",
    );
    let result = await success(
      sendHamta([
        entry(phone, "submitted", { reason: "timeout" }),
        entry(another, "submitted", { reason: "timeout" }),
      ]),
    );
    [phone, another] = result.data;
    assert.equal((await pool("?status=submitted")).count, 2);
    assert.equal(phone.trackingCode, undefined);
    assert.equal(
      (await unitOp(phone, "void", { reason: "Unknown external status" }, qc))
        .status,
      409,
    );
    assert.equal(
      (
        await sendHamta(
          [
            entry(phone, "activated", {
              trackingCode: "TEST-OFFICIAL-EXAMPLE",
            }),
          ],
          "retry",
        )
      ).status,
      409,
    );
    result = await success(
      sendHamta(
        [entry(phone, "error", { reason: "external rejection" })],
        "retry",
      ),
    );
    [phone] = result.data;
    assert.equal(phone.hamtaStatus, "error");
    const reconcile = sendHamta(
      [
        entry(phone, "activated", {
          trackingCode: "TEST-OFFICIAL-EXAMPLE",
          evidence: "test-reference",
        }),
      ],
      "reconcile",
      qc,
      "reconcile-1",
    );
    const activated = (await success(reconcile)).data[0];
    assert.equal(activated.trackingCode, "TEST-OFFICIAL-EXAMPLE");
    assert.equal(
      (
        await success(
          sendHamta(
            [
              entry(phone, "activated", {
                trackingCode: "TEST-OFFICIAL-EXAMPLE",
                evidence: "test-reference",
              }),
            ],
            "reconcile",
            qc,
            "reconcile-1",
          ),
          200,
        )
      ).data[0].id,
      activated.id,
    );
    assert.equal(
      (
        await sendHamta(
          [entry(activated, "submitted", { reason: "again" })],
          "reconcile",
        )
      ).status,
      409,
    );
    assert.equal(
      (await unitOp(activated, "void", { reason: "Already active" }, qc))
        .status,
      409,
    );
    const correction = () =>
      unitOp(
        activated,
        "official-corrections",
        { reference: "official-case-fixture", reason: "Review request" },
        qc,
        "correction-1",
      );
    assert.deepEqual(
      (await Promise.all([correction(), correction()]))
        .map((result) => result.status)
        .sort(),
      [200, 201],
    );
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/az+S1sAAAAASUVORK5CYII=",
      "base64",
    );
    const evidencePath = "/imei/units/" + activated.id + "/hamta-evidence";
    const upload = (buffer, key = secret()) =>
      fetch(base + evidencePath, {
        method: "POST",
        headers: {
          Origin: origin,
          Cookie: qc,
          "Content-Type": "image/png",
          "X-Filename": encodeURIComponent("همتا.png"),
          "Idempotency-Key": key,
        },
        body: buffer,
      });
    assert.equal((await upload(Buffer.from("not an image"))).status, 415);
    assert.equal((await upload(png, "attach-1")).status, 201);
    assert.equal((await upload(png, "attach-1")).status, 200);
    assert.equal((await upload(png)).status, 409);
    const download = await fetch(base + evidencePath, {
      headers: { Origin: origin, Cookie: manager },
    });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), png);
    assert.equal(
      (
        await fetch(base + evidencePath, {
          headers: { Origin: origin, Cookie: managerElsewhere },
        })
      ).status,
      403,
    );
    const log = await success(
      call("/imei/units/" + activated.id + "/history"),
      200,
    );
    assert.ok(log.data.some((row) => row.action === "unit.void"));
    assert.ok(
      log.data.some((row) => row.action === "hamta.official-correction"),
    );
    assert.equal(
      (await success(call("/imei/hamta?status=activated"), 200)).count,
      1,
    );
    const pageOne = await success(call("/imei/hamta?size=1&page=0"), 200);
    const pageTwo = await success(call("/imei/hamta?size=1&page=1"), 200);
    assert.equal(pageOne.count, 2);
    assert.equal(pageTwo.count, 2);
    assert.notEqual(pageOne.data[0].id, pageTwo.data[0].id);
    assert.equal(
      (await success(call("/imei/hamta?q=TEST-OFFICIAL-EXAMPLE"), 200)).data[0]
        .id,
      activated.id,
    );
    assert.deepEqual(
      log.data.find((row) => row.action === "unit.void").detail.numbers,
      obsolete.numbers,
    );
    const tinyModel = await add("models", "TA-150", {
      colorIds: [color.id],
      imeiSlots: 1,
    });
    await success(
      call("/master/versions", "POST", {
        type: "bom",
        modelId: tinyModel.id,
        lines: [{ skuId: sku.id, quantity: "1", stationCode: station.code }],
      }),
    );
    await success(
      call("/master/versions", "POST", {
        type: "routing",
        modelId: tinyModel.id,
        lineId: line.id,
        stationIds: [station.id],
      }),
    );
    await success(importFile(tinyModel.id, [[number(40)]]));
    const tinyInput = { ...orderInput, modelId: tinyModel.id };
    const tiny1 = await success(createOrder(tinyInput));
    const tiny2 = await success(createOrder(tinyInput));
    const race = await Promise.all([allocate(tiny1.id), allocate(tiny2.id)]);
    assert.deepEqual(race.map((entry) => entry.status).sort(), [201, 409]);
    assert.deepEqual(race.find((entry) => entry.status === 201).data.numbers, [
      number(40),
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    try {
      assert.equal(database.name, namespace);
      await database.dropDatabase();
    } finally {
      await database.close();
    }
  }
});
