import { assertContractResponse } from "./support/release-contract.js";
import {
  baselineClients,
  verifyRestartAndLoad,
} from "./support/operational.js";
import { dayWindow } from "../src/insights/calendar.js";
import { ObjectId } from "mongodb";
import { initializeFinished } from "../src/finished/store.js";
import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { initializeDefects } from "../src/defects/store.js";
import { assemblyStore, initializeAssembly } from "../src/assembly/store.js";
import { basketStore, initializeBasket } from "../src/basket/store.js";
import { imeiStore, initializeImei } from "../src/imei/store.js";
import { createApp } from "../src/app.js";
import { catalogStore, initializeCatalog } from "../src/catalog/store.js";
import { readConfig } from "../src/config.js";
import { connectDatabase } from "../src/database/connection.js";
import { handoverStore, initializeHandover } from "../src/handover/store.js";
import { identityRouter } from "../src/identity/routes.js";
import { identityStore, initializeIdentity } from "../src/identity/store.js";
import { initializeInventory, inventoryStore } from "../src/inventory/store.js";
import { initializeShipments, shipmentStore } from "../src/shipments/store.js";

test("Baskets preserve BOM, confirm both kinds of label, reconcile custody, receive independently and pass through versioned assembly and quality", async () => {
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
    store = basketStore(database);
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
      REVAL_ADMIN_USERNAME: "handover-admin",
      REVAL_ADMIN_PASSWORD: initial,
    });
    await initializeCatalog(catalogStore(database));
    await initializeShipments(shipmentStore(database));
    await initializeInventory(inventoryStore(database));
    await initializeHandover(handoverStore(database));
    await initializeImei(imeiStore(database));
    await initializeBasket(store);
    await initializeAssembly(assemblyStore(database));
    await initializeDefects(assemblyStore(database));
    await initializeFinished(assemblyStore(database));
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
      assertContractResponse(method, path, response.status, data);
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
    admin = await login("handover-admin", initial);
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
    const warehouse = await add("warehouses", "WH-A", {}, branch.id);
    const shelf = await add("locations", "A-01-01-1", {}, warehouse.id);
    const line = await add("lines", "L-1", {}, branch.id);
    const otherLine = await add("lines", "L-2", {}, branch.id);
    const stageTest = await add("tests", "POWER", { results: ["OK", "NO"] });
    const station = await add(
      "stations",
      "ST-1",
      {
        order: 1,
        requirements: ["Power connector seated"],
        testIds: [stageTest.id],
        maxRetests: 1,
        allowedRoleIds: ["assemblyOperator"],
        supervisorApproval: true,
      },
      line.id,
    );
    const outsideStation = await add(
      "stations",
      "ST-OUT",
      { order: 1 },
      otherLine.id,
    );
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

    const station2 = await add("stations", "ST-2", { order: 2 }, line.id);
    const wrongModel = await add("models", "TA-140", {
      colorIds: [color.id],
      imeiSlots: 1,
    });
    const bom = async (modelId, quantity) =>
      success(
        call("/master/versions", "POST", {
          type: "bom",
          modelId,
          lines: [{ skuId: sku.id, quantity, stationCode: station.code }],
        }),
      );
    await bom(wrongModel.id, "2");
    for (const modelId of [model.id, wrongModel.id])
      await success(
        call("/master/versions", "POST", {
          type: "routing",
          modelId,
          lineId: line.id,
          stationIds: [station.id, station2.id],
        }),
      );
    const orderFor = (modelId, count) =>
      success(
        call("/imei/orders", "POST", {
          modelId,
          colorId: color.id,
          lineId: line.id,
          count,
        }),
      );
    const order = await orderFor(model.id, 4);
    const wrongOrder = await orderFor(wrongModel.id, 1);
    assert.equal(order.bomVersionId, firstBom.id);
    const published = await bom(model.id, "3");
    assert.notEqual(order.bomVersionId, published.id);
    const numbers = Array.from({ length: 11 }, (_, index) => {
      const base = "00990000" + String(index + 20).padStart(6, "0");
      return (
        base +
        [..."0123456789"].find(
          (digit) =>
            [...(base + digit)].reduce((sum, entry, idx) => {
              const n = Number(entry) * (idx % 2 === 0 ? 1 : 2);
              return sum + (n > 9 ? n - 9 : n);
            }, 0) %
              10 ===
            0,
        )
      );
    });
    const pool = (modelId, pairs) =>
      success(
        call("/imei/imports", "POST", {
          modelId,
          source: "basket-fixture",
          rows: pairs.map((cells, index) => ({ row: index + 1, cells })),
        }),
      );
    await pool(model.id, [
      numbers.slice(0, 2),
      numbers.slice(2, 4),
      numbers.slice(4, 6),
      numbers.slice(6, 8),
      numbers.slice(8, 10),
    ]);
    await pool(wrongModel.id, [[numbers[10]]]);
    const allocated = await success(
      call("/imei/orders/" + order.id + "/units", "POST", {}),
    );

    const document = await success(
      call("/handover/requests", "POST", {
        modelId: model.id,
        warehouseId: warehouse.id,
        lineId: line.id,
        count: 3,
      }),
    );
    const path = "/handover/requests/" + document.id;
    const shipment = await success(
      call("/shipments", "POST", {
        supplierId: supplier.id,
        warehouseId: warehouse.id,
        waybillNumber: "WB-1",
        expectedCartons: 1,
      }),
    );
    const intake = "/shipments/" + shipment.id;
    const pallet = await success(
      call(intake + "/pallets", "POST", { code: "PLT-1405-0001" }),
    );
    const carton = await success(
      call(intake + "/cartons", "POST", {
        palletId: pallet.id,
        code: "CTN-1405-0001",
        lot: "LOT-POWER-1405",
        skuId: sku.id,
        quantity: "10",
      }),
    );
    await success(
      call(intake + "/receipts", "POST", {
        version: (await call(intake)).data.shipment.version,
      }),
    );
    const stock = "/inventory/cartons/" + carton.id;
    await success(
      call(stock + "/moves", "POST", { version: 0, locationId: shelf.id }),
    );
    async function actor(username, roleId, scope) {
      const password = secret();
      await success(
        call("/users", "POST", {
          username,
          name: username,
          password,
          roleId,
          organizationWide: false,
          scopes: [scope],
        }),
      );
      return login(username, password);
    }
    const receiver = await actor("line-basket", "basketOperator", {
      lineId: line.id,
    });
    const outsider = await actor("other-basket", "basketOperator", {
      lineId: otherLine.id,
    });

    const assembler = await actor("assembly-user", "assemblyOperator", {
      lineId: line.id,
    });
    const outsideAssembler = await actor("assembly-other", "assemblyOperator", {
      lineId: otherLine.id,
    });
    const deliveryReservation = await success(
      call(path + "/reservations", "POST", {
        version: 0,
        cartonCode: carton.code,
        quantity: "6",
      }),
    );
    const shipmentDelivery = await success(
      call(path + "/deliveries", "POST", {
        version: 1,
        reservationIds: [deliveryReservation.reservation.id],
      }),
    );
    const item = (await call(path)).data.custody[0];
    await success(
      call(
        "/handover/deliveries/" + shipmentDelivery.delivery.id + "/receipts",
        "POST",
        { version: 0, items: [{ itemId: item.id, quantity: "6" }] },
        receiver,
      ),
    );
    const prepare = (orderId, who = receiver, key = secret()) =>
      call("/basket", "POST", { orderId }, who, key);
    assert.equal((await prepare(order.id, outsider)).status, 403);
    const opts = await call("/basket/options", "GET", undefined, receiver);
    assert.equal(opts.status, 200);
    assert.ok(opts.data.some((entry) => entry.id === order.id));
    assert.equal(
      (await call("/basket/options", "GET", undefined, outsider)).data.length,
      0,
    );
    const first = await success(prepare(order.id, receiver, "prepare-1"));
    assert.equal(first.unitId, allocated.id);
    assert.equal(first.bomVersionId, firstBom.id);
    assert.equal(first.needs[0].quantity, "2");
    assert.equal(
      (await success(prepare(order.id, receiver, "prepare-1"), 200)).id,
      first.id,
    );
    assert.equal(
      (await call("/basket/" + first.id, "GET", undefined, outsider)).status,
      403,
    );
    assert.equal(
      (await call("/basket/" + first.id, "GET", undefined, assembler)).status,
      403,
    );
    const second = await success(prepare(order.id));
    const wrong = await success(prepare(wrongOrder.id));
    async function detail(id, who = receiver) {
      return success(call("/basket/" + id, "GET", undefined, who), 200);
    }
    const op = (row, path, body = {}, who = receiver, key = secret()) =>
      call(
        "/basket/" + row.id + path,
        "POST",
        { version: row.version, ...body },
        who,
        key,
      );
    const readSource = async (id, who = receiver) =>
      success(
        call("/basket/" + id + "/stock?skuId=" + sku.id, "GET", undefined, who),
        200,
      );
    const printer = async (row, path, who = receiver) =>
      fetch(base + "/basket/" + row.id + path, {
        headers: { Origin: origin, Cookie: who },
      });
    const png = async (result) => {
      assert.equal(result.status, 200);
      assert.equal(result.headers.get("content-type"), "image/png");
      return Buffer.from(await result.arrayBuffer());
    };
    async function scanned(row) {
      const info = await detail(row.id);
      assert.equal(info.access.demo, false);
      assert.equal(info.unit.confirmed, false);
      assert.equal(
        (await op(row, "/imei/scan", { code: info.unit.numbers[0] })).status,
        409,
      );
      const printed = (await success(op(row, "/imei/print"))).basket;
      const image = await png(await printer(row, "/labels/imei/1"));
      assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.deepEqual(image, await png(await printer(row, "/labels/imei/1")));
      if (info.unit.numbers.length === 2)
        assert.equal((await printer(row, "/labels/imei/2")).status, 200);
      else assert.equal((await printer(row, "/labels/imei/2")).status, 404);
      assert.equal(
        (await op(printed, "/imei/scan", { code: "1234" })).status,
        409,
      );
      return success(
        op(printed, "/imei/scan", { code: info.unit.numbers.at(-1) }),
      );
    }
    let a = await scanned(first),
      b = await scanned(second),
      bad = await scanned(wrong);
    assert.equal((await readSource(bad.id)).length, 0);
    const source = (await readSource(a.id))[0];
    assert.equal(source.line, "6");
    const inputFor = (quantity) => ({
      skuId: sku.id,
      quantity,
      custodyId: source.id,
    });
    assert.equal((await op(bad, "/parts", inputFor("1"))).status, 409);
    assert.equal((await op(a, "/ready")).status, 409);
    assert.equal((await op(a, "/parts", inputFor("3"))).status, 409);
    const printedA = await success(op(a, "/parts", inputFor("1")));
    const printedB = await success(op(b, "/parts", inputFor("2")));
    a = printedA.basket;
    b = printedB.basket;
    assert.equal((await readSource(a.id))[0].line, "6");
    const pic = await png(
      await printer(a, "/labels/parts/" + printedA.part.id),
    );
    assert.deepEqual(
      pic,
      await png(await printer(a, "/labels/parts/" + printedA.part.id)),
    );
    assert.equal(await store.parts.countDocuments({ basketId: a.id }), 1);
    assert.equal(
      (await printer(a, "/labels/parts/" + printedA.part.id, outsider)).status,
      403,
    );
    assert.equal(
      (await op(a, "/parts/scan", { code: printedB.part.code, skuId: sku.id }))
        .status,
      409,
    );
    assert.equal(
      (await op(a, "/parts/scan", { code: "PRT-999999", skuId: sku.id }))
        .status,
      404,
    );
    const replayBody = { code: printedA.part.code, skuId: sku.id };
    const attempts = await Promise.all([
      op(a, "/parts/scan", replayBody, receiver, "scan-1"),
      op(a, "/parts/scan", replayBody, receiver, "scan-1"),
    ]);
    assert.deepEqual(
      attempts.map((result) => result.status).sort(),
      [200, 201],
    );
    a = attempts[0].data.basket;
    assert.equal((await op(a, "/parts/scan", replayBody)).status, 409);
    const reconcile = () => success(call(stock + "/reconciliation"), 200);
    let recon = await reconcile();
    assert.deepEqual(
      [recon.actual, recon.line, recon.basket, recon.balanced],
      ["4", "5", "1", true],
    );
    const productionStock = await success(
      call("/inventory/carton-stock?account=production&q=" + carton.code),
      200,
    );
    assert.equal(productionStock.data[0].basket, "1");
    assert.equal((await op(a, "/ready")).status, 409);
    const returned = await success(
      op(a, "/parts/" + printedA.part.id + "/remove", {
        reason: "Return before assembly",
      }),
    );
    a = returned.basket;
    assert.equal(returned.part.state, "returned");
    assert.equal((await readSource(a.id))[0].line, "6");
    assert.equal((await reconcile()).balanced, true);
    assert.equal(
      (await printer(a, "/labels/parts/" + printedA.part.id)).status,
      404,
    );

    const full = await success(op(a, "/parts", inputFor("2")));
    a = (
      await success(
        op(full.basket, "/parts/scan", { code: full.part.code, skuId: sku.id }),
      )
    ).basket;
    const ready = await success(op(a, "/ready"));
    assert.equal(ready.status, "ready");
    assert.equal((await op(ready, "/receive", {}, assembler)).status, 409);
    const handed = await success(op(ready, "/handover"));
    assert.equal(handed.status, "handed_over");
    assert.equal((await op(handed, "/handover")).status, 409);
    assert.equal(
      (await op(handed, "/receive", {}, outsideAssembler)).status,
      403,
    );
    assert.equal((await detail(a.id, assembler)).access.receive, true);
    assert.equal(
      (await call("/basket?mode=incoming", "GET", undefined, assembler)).data
        .count,
      1,
    );
    const received = await success(
      op(handed, "/receive", {}, assembler, "receiver"),
    );
    assert.equal(received.status, "received");
    assert.equal(
      (await success(op(handed, "/receive", {}, assembler, "receiver"), 200))
        .id,
      received.id,
    );
    assert.equal((await op(received, "/receive", {}, assembler)).status, 409);
    assert.equal(
      (await call("/basket/" + a.id + "/export", "GET", undefined, receiver))
        .status,
      200,
    );
    assert.equal(
      (await call("/basket/" + a.id + "/export", "GET", undefined, assembler))
        .status,
      403,
    );

    const pending = b;
    b = (
      await success(
        op(pending, "/parts/scan", { code: printedB.part.code, skuId: sku.id }),
      )
    ).basket;
    b = await success(op(b, "/ready"));
    b = await success(op(b, "/handover", {}, admin));
    const blocked = await op(b, "/receive", {}, admin);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.error.code, "SENDER_CANNOT_RECEIVE");
    recon = await reconcile();
    assert.deepEqual(
      [recon.actual, recon.line, recon.basket, recon.balanced],
      ["4", "2", "4", true],
    );

    const old = await store.imei.units.findOne({ basketId: b.id });
    const voided = await success(
      call("/imei/units/" + old._id + "/void", "POST", {
        version: old.version,
        reason: "Damaged phone label",
      }),
    );
    assert.equal((await detail(b.id)).unit.confirmed, false);
    assert.equal((await op(b, "/receive", {}, assembler)).status, 409);
    const replacement = await success(
      call("/imei/units/" + old._id + "/replace", "POST", {
        version: voided.version,
      }),
    );
    assert.equal(replacement.id, String(old._id));
    assert.equal(replacement.basketId, b.id);
    assert.notDeepEqual(replacement.numbers, old.numbers);
    assert.equal(
      (await printer(b, "/labels/imei/1?pair=" + old.pairId)).status,
      404,
    );
    b = (await success(op(b, "/imei/print"))).basket;
    assert.equal(
      (await op(b, "/imei/scan", { code: old.numbers[0] })).status,
      409,
    );
    b = await success(op(b, "/imei/scan", { code: replacement.numbers[0] }));
    await success(op(b, "/receive", {}, assembler));
    assert.equal((await reconcile()).basket, "4");

    const releaseDraft = await success(prepare(order.id));
    const phone = await store.imei.units.findOne({ basketId: releaseDraft.id });
    await success(
      call("/imei/units/" + phone._id + "/release", "POST", {
        version: phone.version,
        reason: "Abandoned unprinted draft",
      }),
    );
    assert.equal((await detail(releaseDraft.id)).basket.status, "cancelled");
    const listed = await call(
      "/basket?size=1&page=1",
      "GET",
      undefined,
      receiver,
    );
    assert.equal(listed.status, 200);
    assert.equal(listed.data.count, 4);
    assert.equal(listed.data.data.length, 1);

    const peer = await actor("assembly-peer", "assemblyOperator", {
      lineId: line.id,
      stationId: station.id,
    });
    const stageAuditor = await actor("quality-peer", "qcManager", {
      lineId: line.id,
      stationId: station.id,
    });
    const queue = (stationId, who = assembler) =>
      call("/assembly/queue?stationId=" + stationId, "GET", undefined, who);
    const queued = await success(queue(station.id), 200);
    assert.equal(queued.count, 2);
    assert.equal(queued.items[0].status, "queued");
    assert.equal((await queue(station2.id, peer)).status, 403);
    const entryCode = (await detail(received.id)).unit.numbers[0];
    const entry = (who, stationId = station.id, modelId = model.id) =>
      call(
        "/assembly/entry",
        "POST",
        { stationId, modelId, code: entryCode },
        who,
      );
    assert.equal((await entry(assembler, station2.id)).status, 409);
    assert.equal(
      (await entry(outsideAssembler, outsideStation.id)).status,
      409,
    );
    assert.equal((await entry(outsideAssembler)).status, 403);
    assert.equal(
      (await entry(assembler, station.id, wrongModel.id)).status,
      409,
    );
    assert.equal((await entry(admin)).status, 403);
    const competing = await Promise.all([entry(assembler), entry(peer)]);
    assert.deepEqual(competing.map((row) => row.status).sort(), [201, 409]);
    const [owner, opponent] =
      competing[0].status === 201 ? [assembler, peer] : [peer, assembler];
    let { visit } = competing.find((row) => row.status === 201).data;
    const visitId = visit.id;
    const visitPath = "/assembly/visits/" + visitId;
    const detailVisit = (who = owner) =>
      success(call(visitPath, "GET", undefined, who), 200);
    assert.equal(
      (await detailVisit()).settings.requirements[0],
      "Power connector seated",
    );
    assert.equal((await success(entry(owner))).visit.id, visitId);
    const command = (
      action,
      body = {},
      who = owner,
      key = secret(),
      version = visit.version,
    ) => call(visitPath + "/" + action, "POST", { version, ...body }, who, key);
    const advanceVisit = async (request) => {
      const result = await success(request);
      visit = result.visit;
      return result;
    };
    assert.equal(
      (await command("complete", { code: entryCode, checklist: [true] }))
        .status,
      409,
    );
    assert.equal(
      (await command("install", { code: printedB.part.code })).status,
      404,
    );
    assert.equal(
      (await command("install", { code: full.part.code }, opponent)).status,
      409,
    );
    const oldVersion = visit.version;
    await advanceVisit(
      command("install", { code: full.part.code }, owner, "install-part"),
    );
    assert.equal(
      (
        await command(
          "install",
          { code: full.part.code },
          owner,
          "install-part",
          oldVersion,
        )
      ).status,
      200,
    );
    assert.equal(
      (await command("install", { code: full.part.code })).status,
      409,
    );
    const consumed = await reconcile();
    assert.deepEqual(
      [consumed.basket, consumed.consumed, consumed.balanced],
      ["2", "2", true],
    );
    assert.equal((await detailVisit()).parts[0].state, "installed");
    assert.equal(
      (await command("complete", { code: entryCode, checklist: [false] }))
        .status,
      409,
    );
    assert.equal(
      (
        await command("complete", {
          code: replacement.numbers[0],
          checklist: [true],
        })
      ).status,
      409,
    );
    await advanceVisit(
      command("complete", { code: entryCode, checklist: [true] }),
    );
    assert.equal(
      (
        await success(
          call("/assembly/testing", "GET", undefined, stageAuditor),
          200,
        )
      ).items[0].id,
      visit.id,
    );
    assert.equal((await command("transfer", {}, admin)).status, 409);
    const failed = await advanceVisit(
      command("test", { testId: stageTest.id, answer: "NO", outcome: "fail" }),
    );
    assert.equal((await command("transfer", {}, admin)).status, 409);
    const retest = await advanceVisit(
      command("test", {
        testId: stageTest.id,
        answer: "NO",
        outcome: "review",
      }),
    );
    assert.equal(retest.result.attempt, 2);
    assert.equal(
      (
        await command("test", {
          testId: stageTest.id,
          answer: "OK",
          outcome: "pass",
        })
      ).status,
      409,
    );
    const correction = {
      testId: stageTest.id,
      answer: "OK",
      outcome: "pass",
      replacesId: retest.result.id,
      reason: "Recorded wrong answer",
    };
    assert.equal((await command("correct", correction)).status, 403);
    assert.equal(
      (
        await command(
          "correct",
          { ...correction, replacesId: failed.result.id },
          stageAuditor,
        )
      ).status,
      409,
    );
    const corrected = await advanceVisit(
      command("correct", correction, stageAuditor),
    );
    assert.equal(corrected.result.revision, 2);
    const report = await success(
      call(
        "/assembly/results?size=1&outcome=fail",
        "GET",
        undefined,
        stageAuditor,
      ),
      200,
    );
    assert.equal(report.count, 1);
    assert.equal(report.items[0].id, failed.result.id);
    const rate = await success(
      call("/assembly/results?tab=rates", "GET", undefined, stageAuditor),
      200,
    );
    assert.deepEqual(
      [rate.items[0].total, rate.items[0].failed, rate.items[0].review],
      [2, 1, 0],
    );
    assert.equal((await detailVisit(stageAuditor)).results.length, 3);
    assert.equal((await command("transfer", {}, owner)).status, 403);
    assert.equal(
      (await advanceVisit(command("transfer", {}, admin))).nextStation,
      station2.code,
    );
    assert.ok(visit.entryAt && visit.completedAt && visit.exitAt);
    assert.equal((await success(queue(station.id), 200)).count, 1);
    assert.equal(
      (await success(queue(station2.id), 200)).items[0].unitCode,
      visit.unitCode,
    );
    const next = (await success(entry(assembler, station2.id))).visit;
    assert.equal(next.status, "installing");
    const nextDetails = await success(
      call("/assembly/visits/" + next.id, "GET", undefined, assembler),
      200,
    );
    assert.equal(nextDetails.routeLength, 2);
    assert.deepEqual(
      nextDetails.history.map((row) => row.id),
      [visitId, next.id],
    );
    assert.equal(
      (
        await call(
          "/assembly/visits/" + next.id,
          "GET",
          undefined,
          stageAuditor,
        )
      ).status,
      403,
    );
    const completeNext = await success(
      call(
        "/assembly/visits/" + next.id + "/complete",
        "POST",
        { version: next.version, code: entryCode, checklist: [] },
        assembler,
      ),
    );
    const exited = await success(
      call(
        "/assembly/visits/" + next.id + "/transfer",
        "POST",
        { version: completeNext.visit.version },
        assembler,
      ),
    );
    assert.equal(exited.nextStation, null);

    const product = assemblyStore(database);
    const finalPath = "/final-qc/" + (await detail(received.id)).unit.id;
    const finalList = await success(
      call("/final-qc?modelId=" + model.id + "&q=" + entryCode),
      200,
    );
    assert.equal(finalList.count, 1);
    const qc = () => success(call(finalPath), 200);
    const stepQc = async (action, body = {}, key = secret()) => {
      const data = await qc();
      return call(
        finalPath + "/" + action,
        "POST",
        { version: data.record?.version ?? 0, ...body },
        admin,
        key,
      );
    };
    assert.equal((await stepQc("approve", { code: entryCode })).status, 409);
    const firstItem = Object.keys((await qc()).checks)[0];
    await success(stepQc("check", { item: firstItem, outcome: "fail" }));
    assert.equal(
      (await stepQc("reject", { stationId: otherLine.id, reason: "Fault" }))
        .status,
      409,
    );
    const rejected = await success(
      stepQc("reject", {
        stationId: station.id,
        reason: "Repeat functional checks",
      }),
    );
    assert.equal(rejected.status, "rework");
    assert.equal(
      (await stepQc("check", { item: firstItem, outcome: "pass" })).status,
      409,
    );
    const reentered = (await success(entry(assembler, station.id))).visit;
    assert.notEqual(reentered.id, visitId);
    const reworkPath = "/assembly/visits/" + reentered.id;
    const completedAgain = await success(
      call(
        reworkPath + "/complete",
        "POST",
        { version: reentered.version, code: entryCode, checklist: [true] },
        assembler,
      ),
    );
    const passedAgain = await success(
      call(
        reworkPath + "/test",
        "POST",
        {
          version: completedAgain.visit.version,
          testId: stageTest.id,
          answer: "OK",
          outcome: "pass",
        },
        assembler,
      ),
    );
    await success(
      call(
        reworkPath + "/transfer",
        "POST",
        { version: passedAgain.visit.version },
        admin,
      ),
    );
    const secondRound = await qc();
    assert.equal(secondRound.record.round, 2);
    assert.equal(secondRound.record.status, "testing");
    assert.equal(secondRound.rejections[0].round, 1);
    for (const item of Object.keys(secondRound.checks))
      await success(stepQc("check", { item, outcome: "pass" }));
    assert.equal(
      (await stepQc("approve", { code: "123456789012345" })).status,
      409,
    );
    const unresolvedId = new ObjectId();
    await product.defects.insertOne({
      _id: unresolvedId,
      visitId: reentered.id,
      unitCode: reentered.unitCode,
      scope: { lineId: line.id },
      testId: stageTest.id,
      testName: "POWER",
      resultId: passedAgain.result.id,
      status: "technical",
      version: 1,
      reason: "Fixture open defect",
      at: new Date(),
      actorId: "test",
    });
    assert.equal((await stepQc("approve", { code: entryCode })).status, 409);
    await product.defects.updateOne(
      { _id: unresolvedId },
      { $set: { status: "resolved" } },
    );
    const finalOk = await success(stepQc("approve", { code: entryCode }));
    const packedPhone = (await qc()).unit;
    const originalUnit = await product.imei.units.findOne({
      _id: new ObjectId(packedPhone.id),
    });
    assert.ok(originalUnit.qcPassedAt);
    assert.equal(originalUnit.hamtaStatus, "pending");
    assert.equal(
      (
        await stepQc("pack", {
          scans: packedPhone.numbers,
          checklist: [true, true, true],
        })
      ).status,
      409,
    );
    const label = await success(stepQc("label"));
    const labelAgain = await success(stepQc("label"));
    assert.equal(label.version, labelAgain.version);
    assert.equal(
      (
        await fetch(base + finalPath + "/label/2", {
          headers: { Cookie: admin },
        })
      ).headers.get("content-type"),
      "image/png",
    );
    assert.equal(
      (
        await stepQc("pack", {
          scans: [...packedPhone.numbers].reverse(),
          checklist: [true, true, true],
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await stepQc("pack", {
          scans: packedPhone.numbers,
          checklist: [true, false, true],
        })
      ).status,
      409,
    );
    const packed = await success(
      stepQc("pack", {
        scans: packedPhone.numbers,
        checklist: [true, true, true],
      }),
    );
    assert.equal(packed.status, "packed");
    assert.equal(
      (
        await stepQc("pack", {
          scans: packedPhone.numbers,
          checklist: [true, true, true],
        })
      ).status,
      409,
    );
    assert.equal(finalOk.status, "passed");

    const outputWarehouse = await add(
      "warehouses",
      "WH-FIN",
      { purpose: "finished" },
      branch.id,
    );
    const shelfA = await add(
      "locations",
      "A-02-01-1",
      { allowedModelIds: [model.id] },
      outputWarehouse.id,
    );
    const shelfB = await add("locations", "A-02-02-1", {}, outputWarehouse.id);
    const wrongShelf = await add(
      "locations",
      "A-02-03-1",
      { allowedModelIds: [wrongModel.id] },
      outputWarehouse.id,
    );
    const outputActor = await actor("finished-worker", "fgOfficer", {
      warehouseId: outputWarehouse.id,
    });
    const cartons = "/finished/cartons";
    const createOutput = () =>
      success(
        call(
          cartons,
          "POST",
          {
            warehouseId: outputWarehouse.id,
            modelId: model.id,
            colorId: color.id,
          },
          outputActor,
        ),
      );
    const change = (carton, action, body = {}) =>
      call(
        cartons + "/" + carton.id + "/" + action,
        "POST",
        { version: carton.version, ...body },
        outputActor,
      );
    let main = await createOutput(),
      spare = await createOutput();
    assert.equal(
      (await change(main, "close", { code: main.code })).status,
      409,
    );
    assert.equal((await change(main, "label")).status, 409);
    assert.equal(
      (
        await change(main, "place", {
          locationId: shelfA.id,
          code: shelfA.code,
        })
      ).status,
      409,
    );
    const contention = await Promise.all([
      change(main, "scan", { code: entryCode }),
      change(spare, "scan", { code: entryCode }),
    ]);
    assert.deepEqual(contention.map((row) => row.status).sort(), [201, 409]);
    if (contention[0].status === 201) main = contention[0].data;
    else [main, spare] = [contention[1].data, main];
    assert.equal(
      (await change(spare, "scan", { code: entryCode })).status,
      409,
    );
    main = await success(change(main, "remove", { unitId: packedPhone.id }));
    main = await success(change(main, "scan", { code: entryCode }));
    const wrongColor = await add("colors", "BLUE");
    const alternateOrder = {
      ...(await product.imei.orders.findOne({
        _id: new ObjectId(originalUnit.orderId),
      })),
      _id: new ObjectId(),
      code: "P12-COLOR",
      colorId: wrongColor.id,
    };
    await product.imei.orders.insertOne(alternateOrder);
    const otherModelOrder = {
      ...alternateOrder,
      _id: new ObjectId(),
      code: "P12-MODEL",
      modelId: wrongModel.id,
      colorId: color.id,
    };
    await product.imei.orders.insertOne(otherModelOrder);
    async function fixtureBox(index, orderId = originalUnit.orderId) {
      const id = new ObjectId(),
        number = "7700000000" + String(index).padStart(5, "0");
      await product.imei.units.insertOne({
        ...originalUnit,
        _id: id,
        orderId,
        code: "P12-FIX-" + index,
        qcPassedAt: new Date("2020-01-01T00:00:00Z"),
        numbers: [number],
        pairId: String(new ObjectId()),
      });
      const pair = (await product.imei.units.findOne({ _id: id })).pairId;
      await product.final.insertOne({
        _id: id,
        version: 1,
        round: 1,
        status: "packed",
        labelPairId: pair,
        packedAt: new Date(),
      });
      return { id: String(id), number };
    }
    const badColor = await fixtureBox(21, String(alternateOrder._id));
    const badModel = await fixtureBox(22, String(otherModelOrder._id));
    assert.equal(
      (await change(main, "scan", { code: badColor.number })).status,
      409,
    );
    assert.equal(
      (await change(main, "scan", { code: badModel.number })).status,
      409,
    );
    for (let i = 0; i < 8; i++) {
      const box = await fixtureBox(i);
      main = await success(change(main, "scan", { code: box.number }));
    }
    const surplus = await fixtureBox(9);
    assert.equal(
      (await change(main, "scan", { code: surplus.number })).status,
      409,
    );
    main = await success(change(main, "label"));
    assert.equal((await success(change(main, "label"))).version, main.version);
    assert.equal(
      (
        await fetch(base + cartons + "/" + main.id + "/label", {
          headers: { Cookie: outputActor },
        })
      ).headers.get("content-type"),
      "image/png",
    );
    main = await success(change(main, "remove", { unitId: packedPhone.id }));
    main = await success(change(main, "scan", { code: entryCode }));
    assert.equal(
      (await change(main, "close", { code: main.code })).status,
      409,
    );
    main = await success(change(main, "label"));
    assert.equal((await change(main, "close", { code: "WRONG" })).status, 409);
    main = await success(change(main, "close", { code: main.code }));
    const finishedInventory =
      "/inventory/warehouse-stock/finished?q=" + entryCode;
    assert.equal((await success(call(finishedInventory), 200)).count, 0);
    assert.equal(
      (await change(main, "remove", { unitId: packedPhone.id })).status,
      409,
    );
    assert.equal(
      (
        await change(main, "place", {
          locationId: wrongShelf.id,
          code: wrongShelf.code,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await change(main, "place", {
          locationId: shelfA.id,
          code: shelfB.code,
        })
      ).status,
      409,
    );
    main = await success(
      change(main, "place", { locationId: shelfA.id, code: shelfA.code }),
    );
    assert.equal(
      (
        await change(main, "place", {
          locationId: shelfA.id,
          code: shelfA.code,
        })
      ).status,
      409,
    );
    main = await success(
      change(main, "place", { locationId: shelfB.id, code: shelfB.code }),
    );
    const productStock = await success(
      call(
        cartons + "?tab=stock&by=imei&q=" + entryCode,
        "GET",
        undefined,
        outputActor,
      ),
      200,
    );
    assert.equal(productStock.items[0].locationId, shelfB.id);
    assert.equal(productStock.count, 1);
    const finishedWarehouse =
      finishedInventory + "&warehouseId=" + outputWarehouse.id;
    const finishedInventoryRow = await success(call(finishedWarehouse), 200);
    assert.equal(finishedInventoryRow.count, 1);
    assert.equal(finishedInventoryRow.data[0].code, main.code);
    assert.equal(finishedInventoryRow.data[0].quantity, "9");
    const distributionOrder = {
      code: "D01-FUTURE-FIXTURE",
      scope: { warehouseId: outputWarehouse.id },
      allocation: { cartonId: main.id, unitId: packedPhone.id },
    };
    const futureOrders = database.db.collection("reval_distribution_orders");
    await futureOrders.insertOne(distributionOrder);
    const storedOrder = await futureOrders.findOne({
      code: distributionOrder.code,
    });
    assert.deepEqual(storedOrder.allocation, distributionOrder.allocation);
    const linkedCarton = await success(
      call(cartons + "/" + storedOrder.allocation.cartonId),
      200,
    );
    assert.ok(
      linkedCarton.carton.members.some(
        (member) => member.unitId === storedOrder.allocation.unitId,
      ),
    );
    assert.deepEqual(
      await success(call(finishedWarehouse), 200),
      finishedInventoryRow,
    );
    assert.deepEqual(
      await success(call(finishedWarehouse + "&print=true"), 200),
      finishedInventoryRow,
    );
    assert.equal(
      (
        await success(
          call(finishedInventory + "&warehouseId=" + warehouse.id),
          200,
        )
      ).count,
      0,
    );

    const officer = await actor("defect-officer", "defectsOfficer", {
      warehouseId: warehouse.id,
    });
    const send = (path, body, who = assembler, key = secret()) =>
      call(path, "POST", body, who, key);
    let secondVisit = (
      await success(
        send("/assembly/entry", {
          stationId: station.id,
          modelId: model.id,
          code: replacement.numbers[0],
        }),
      )
    ).visit;
    const secondPath = "/assembly/visits/" + secondVisit.id;
    const stage = async (action, body, who = assembler) => {
      const result = await success(
        send(
          secondPath + "/" + action,
          { version: secondVisit.version, ...body },
          who,
        ),
      );
      secondVisit = result.visit;
      return result;
    };
    const refresh = async () => {
      secondVisit = (
        await success(call(secondPath, "GET", undefined, assembler), 200)
      ).visit;
    };
    await stage("install", { code: printedB.part.code });
    await stage("complete", {
      code: replacement.numbers[0],
      checklist: [true],
    });
    const review = (
      await stage("test", {
        testId: stageTest.id,
        answer: "NO",
        outcome: "review",
      })
    ).result;
    const open = "/defects/visits/" + secondVisit.id;
    const referred = await success(
      send(open + "/refer", {
        testId: stageTest.id,
        resultId: review.id,
        reason: "Inspect seating",
      }),
    );
    const technical = "/defects/cases/" + referred.id;
    assert.equal(
      (
        await send(technical + "/decide", {
          version: referred.version,
          decision: "rework",
          reason: "Reseat",
        })
      ).status,
      403,
    );
    const decision = await success(
      send(
        technical + "/decide",
        { version: referred.version, decision: "rework", reason: "Reseat" },
        stageAuditor,
      ),
    );
    assert.equal(
      (
        await send(technical + "/rework", {
          version: decision.version,
          code: replacement.numbers[0],
          checklist: [false],
          reason: "Reseated",
        })
      ).status,
      409,
    );
    await success(
      send(technical + "/rework", {
        version: decision.version,
        code: replacement.numbers[0],
        checklist: [true],
        reason: "Reseated",
      }),
    );
    await refresh();
    const passed = (
      await stage("test", {
        testId: stageTest.id,
        answer: "OK",
        outcome: "pass",
      })
    ).result;
    assert.equal(
      (await success(call(technical, "GET", undefined, stageAuditor), 200)).case
        .status,
      "resolved",
    );
    const defectResult = (
      await stage(
        "correct",
        {
          testId: stageTest.id,
          answer: "NO",
          outcome: "fail",
          replacesId: passed.id,
          reason: "Wrong reading recorded",
        },
        stageAuditor,
      )
    ).result;
    const declared = await success(
      send(open + "/declare", {
        testId: stageTest.id,
        resultId: defectResult.id,
        partId: printedB.part.id,
        reason: "Connector failed",
      }),
    );
    assert.equal(
      (
        await send(open + "/declare", {
          testId: stageTest.id,
          resultId: defectResult.id,
          partId: printedB.part.id,
          reason: "Duplicate",
        })
      ).status,
      409,
    );
    const defect = "/defects/cases/" + declared.id;
    assert.equal(
      (
        await send(defect + "/label", {
          version: declared.version,
          custodyId: line.id,
        })
      ).status,
      409,
    );
    assert.equal((await reconcile()).balanced, true);
    const reserved = await success(
      send(defect + "/label", {
        version: declared.version,
        custodyId: item.id,
      }),
    );
    assert.equal(
      (
        await send(defect + "/label", {
          version: reserved.version,
          custodyId: item.id,
        })
      ).status,
      409,
    );
    const parts = await success(call(defect, "GET", undefined, assembler), 200);
    assert.equal(parts.replacement.replacesPartId, printedB.part.id);
    const barcode = await fetch(base + defect + "/label", {
      headers: { Cookie: assembler },
    });
    assert.equal(barcode.headers.get("content-type"), "image/png");
    assert.equal(
      (
        await send(defect + "/install", {
          version: reserved.version,
          code: printedB.part.code,
        })
      ).status,
      409,
    );
    const installed = await success(
      send(defect + "/install", {
        version: reserved.version,
        code: parts.replacement.code,
      }),
    );
    assert.equal(installed.status, "retest");
    assert.equal(
      (
        await send(defect + "/install", {
          version: installed.version,
          code: parts.replacement.code,
        })
      ).status,
      409,
    );
    assert.equal((await reconcile()).balanced, true);
    await refresh();
    const failedAgain = (
      await stage("test", {
        testId: stageTest.id,
        answer: "NO",
        outcome: "fail",
      })
    ).result;
    assert.equal(
      (await success(call(defect, "GET", undefined, assembler), 200)).case
        .status,
      "retest_failed",
    );
    assert.equal(
      (
        await send(
          secondPath + "/transfer",
          { version: secondVisit.version },
          admin,
        )
      ).status,
      409,
    );
    const retry = await success(
      send(open + "/declare", {
        testId: stageTest.id,
        resultId: failedAgain.id,
        partId: parts.replacement.id,
        reason: "Replacement also failed",
      }),
    );
    assert.equal(
      (
        await send("/defects/cases/" + retry.id + "/label", {
          version: retry.version,
          custodyId: item.id,
        })
      ).status,
      409,
    );

    const storePart = "/defects/receive";
    const defectInventory =
      "/inventory/warehouse-stock/defects?warehouseId=" +
      warehouse.id +
      "&q=" +
      printedB.part.code;
    assert.equal((await success(call(defectInventory), 200)).count, 0);
    assert.equal(
      (await call(defectInventory, "GET", undefined, officer)).status,
      403,
    );
    assert.equal(
      (await send(storePart, { code: printedB.part.code })).status,
      403,
    );
    await success(send(storePart, { code: printedB.part.code }, officer));
    const defectiveStock = await success(call(defectInventory), 200);
    assert.equal(defectiveStock.count, 1);
    assert.equal(defectiveStock.data[0].code, printedB.part.code);
    assert.equal(defectiveStock.data[0].sourceCarton, carton.code);
    assert.equal(defectiveStock.data[0].quantity, "2");
    const defectViewer = await actor("defect-stock-viewer", "whManager", {
      warehouseId: warehouse.id,
    });
    const outsideDefectViewer = await actor(
      "other-defect-viewer",
      "whManager",
      {
        warehouseId: outputWarehouse.id,
      },
    );
    assert.equal(
      (
        await success(
          call(defectInventory, "GET", undefined, defectViewer),
          200,
        )
      ).count,
      1,
    );
    assert.equal(
      (
        await success(
          call(defectInventory, "GET", undefined, outsideDefectViewer),
          200,
        )
      ).count,
      0,
    );
    assert.equal(
      (
        await call(
          defectInventory + "&print=true",
          "GET",
          undefined,
          defectViewer,
        )
      ).status,
      403,
    );
    assert.equal(
      (await send(storePart, { code: printedB.part.code }, officer)).status,
      409,
    );
    const ret = await success(
      send(
        "/defects/returns",
        { partIds: [printedB.part.id] },
        officer,
        "supplier-return-1",
      ),
    );
    assert.equal(
      (
        await success(
          send(
            "/defects/returns",
            { partIds: [printedB.part.id] },
            officer,
            "supplier-return-1",
          ),
          200,
        )
      ).id,
      ret.id,
    );
    assert.equal(
      (await send("/defects/returns", { partIds: [printedB.part.id] }, officer))
        .status,
      409,
    );
    const advance = "/defects/returns/" + ret.id + "/advance";
    assert.equal(
      (
        await send(
          advance,
          { version: ret.version, status: "delivered", reference: "Receipt" },
          officer,
        )
      ).status,
      409,
    );
    const dispatched = await success(
      send(
        advance,
        { version: ret.version, status: "dispatched", reference: "Waybill" },
        officer,
      ),
    );
    assert.equal((await success(call(defectInventory), 200)).count, 1);
    const delivered = await success(
      send(
        advance,
        {
          version: dispatched.version,
          status: "delivered",
          reference: "Receipt",
        },
        officer,
      ),
    );
    assert.equal(delivered.status, "delivered");
    assert.equal((await success(call(defectInventory), 200)).count, 0);
    assert.equal((await reconcile()).nonAllocatable.supplier_return, "2");
    assert.equal(
      (
        await send(
          advance,
          {
            version: delivered.version,
            status: "delivered",
            reference: "Receipt",
          },
          officer,
        )
      ).status,
      409,
    );
    assert.equal((await reconcile()).balanced, true);

    const technicalVisit = (
      await success(call(secondPath, "GET", undefined, assembler), 200)
    ).visit;
    assert.equal(technicalVisit.status, "testing");

    const insights = (path, who = admin) =>
      success(call(path, "GET", undefined, who), 200);
    const findLot = await insights("/trace?kind=material&q=LOT-POWER-1405");
    assert.equal(findLot[0].count, 1);
    assert.equal(findLot[0].items[0].id, carton.id);
    const oldPart = await insights("/trace/parts/" + printedB.part.id);
    assert.equal(
      oldPart.parts.find((part) => part.id === parts.replacement.id)
        .replacesPartId,
      printedB.part.id,
    );
    assert.equal(oldPart.shipments[0].supplierName, supplier.name);
    assert.equal(
      oldPart.returns.find((row) => row.id === delivered.id).status,
      "delivered",
    );
    assert.ok(oldPart.ledger.some((row) => row.to === "supplier_return"));
    assert.ok(Object.keys(oldPart.actors).length > 0);
    const stockTrace = await insights("/trace/finished/" + main.id);
    assert.ok(stockTrace.units.some((row) => row.numbers.includes(entryCode)));
    const officerPart = await insights(
      "/trace/parts/" + printedB.part.id,
      officer,
    );
    assert.equal(officerPart.units.length, 0);
    assert.equal(officerPart.shipments.length, 1);
    assert.equal(
      (await call("/trace/finished/" + main.id, "GET", undefined, officer))
        .status,
      404,
    );
    const excluded = await insights(
      "/trace?kind=finished&q=" + main.code,
      officer,
    );
    assert.equal(excluded[0].count, 0);

    const ledgers = await insights("/reports?kind=ledger");
    assert.ok(ledgers.snapshot.length > 0);
    assert.ok(ledgers.snapshot.every((row) => row.balanced));
    assert.equal(
      ledgers.snapshot.find(
        (row) => row.sku === sku.code && row.account === "storage",
      ).expected,
      (await reconcile()).expected,
    );
    const data = await insights(
      "/reports?kind=material&q=LOT-POWER-1405&size=1",
    );
    assert.equal(data.count, 1);
    assert.equal(data.quantity, "10");
    assert.equal(
      data.items[0][data.columns.findIndex((column) => column.key === "lot")],
      "LOT-POWER-1405",
    );
    const csv = await fetch(
      base + "/reports?kind=material&q=LOT-POWER-1405&export=csv",
      { headers: { Cookie: admin } },
    );
    const csvBody = await csv.text();
    assert.equal(csv.status, 200);
    assert.equal(csvBody.trim().split("\r\n").length, 2);
    assert.match(csvBody, /LOT-POWER-1405/);
    const scoped = await insights("/reports?kind=finished", officer);
    assert.equal(scoped.count, 0);
    const scopedCsv = await fetch(base + "/reports?kind=finished&export=csv", {
      headers: { Cookie: officer },
    });
    assert.equal((await scopedCsv.text()).trim().split("\r\n").length, 1);
    assert.equal(
      (
        await call(
          "/reports?kind=ledger&export=csv",
          "GET",
          undefined,
          assembler,
        )
      ).status,
      403,
    );
    const metrics = await insights("/dashboard?lineId=" + line.id);
    assert.ok(
      metrics.production.some(
        (row) => row._id.line === line.name && row.count === 1,
      ),
    );
    assert.equal(
      (await insights("/dashboard?lineId=" + otherLine.id)).production.length,
      0,
    );
    const tehran = dayWindow(1, new Date("2026-11-20T20:29:59Z"));
    assert.equal(tehran.$gte.toISOString(), "2026-11-19T20:30:00.000Z");
    assert.equal(tehran.$lt.toISOString(), "2026-11-20T20:30:00.000Z");
    const midnight = dayWindow(1, new Date(tehran.$lt));
    assert.equal(midnight.$gte.toISOString(), tehran.$lt.toISOString());
    const earlier = await insights(
      "/reports?kind=material&period=1&q=LOT-POWER-1405",
    );
    assert.equal(earlier.count, 1);

    const codes = await insights("/trace/options");
    assert.ok(codes.some((row) => row.id === type.id));
    const lots = await insights(
      "/trace?mode=material-lot&partTypeId=" + type.id,
    );
    assert.equal(lots[0].kind, "material");
    assert.equal(lots[0].items[0].lot, "LOT-POWER-1405");
    assert.equal(
      (await insights("/trace?mode=material-lot&partTypeId=" + model.id))[0]
        .count,
      0,
    );
    assert.equal(
      (await insights("/trace?mode=material-carton&q=" + carton.code))[0]
        .items[0].id,
      carton.id,
    );
    assert.equal(
      (await insights("/trace?mode=defective&q=" + printedB.part.code))[0]
        .items[0].status,
      "supplier_return",
    );
    assert.equal(
      (await insights("/trace?mode=defective&q=" + full.part.code))[0].count,
      0,
    );
    assert.equal(
      (await insights("/trace?mode=finished-carton&q=" + main.code))[0].items[0]
        .id,
      main.id,
    );
    const waiting = await insights(
      "/trace?mode=in-line&q=" + replacement.numbers[0],
    );
    assert.equal(waiting[0].count, 1);
    assert.equal(
      (await insights("/trace?mode=in-line&q=" + entryCode))[0].count,
      0,
    );
    assert.equal(
      (
        await insights(
          "/trace?mode=stored-replacement&q=" + replacement.numbers[0],
        )
      )[0].count,
      0,
    );
    const returnedUnit = (await detail(b.id)).unit;
    const sourceMaster = await product.finishedCartons.findOne({
      _id: new ObjectId(main.id),
    });
    const replacementCarton = new ObjectId();
    await product.finishedCartons.insertOne({
      ...sourceMaster,
      _id: replacementCarton,
      code: "QA-STORED-REPLACEMENT",
      members: [
        {
          unitId: returnedUnit.id,
          unitCode: secondVisit.unitCode,
          numbers: replacement.numbers,
        },
      ],
    });
    try {
      const corrected = await insights(
        "/trace?mode=stored-replacement&q=" + replacement.numbers[0],
      );
      assert.equal(corrected[0].items[0].id, returnedUnit.id);
      const denied = await insights(
        "/trace?mode=stored-replacement&q=" + replacement.numbers[0],
        officer,
      );
      assert.equal(denied[0].count, 0);
    } finally {
      await product.finishedCartons.deleteOne({ _id: replacementCarton });
    }
    assert.equal((await call("/trace?mode=defective&kind=units")).status, 400);
    const samplePhones = [];
    const clients = baselineClients();
    for (let index = 100; index < 100 + clients; index++)
      samplePhones.push((await fixtureBox(index)).number);
    await verifyRestartAndLoad({
      uri,
      origin,
      admin,
      operator: outputActor,
      carton: {
        warehouseId: outputWarehouse.id,
        modelId: model.id,
        colorId: color.id,
      },
      phoneCode: entryCode,
      samplePhones,
      db: database,
    });
    assert.equal((await entry(assembler, station2.id)).status, 409);
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
