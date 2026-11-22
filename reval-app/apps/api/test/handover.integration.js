import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { catalogStore, initializeCatalog } from "../src/catalog/store.js";
import { readConfig } from "../src/config.js";
import { connectDatabase } from "../src/database/connection.js";
import { handoverStore, initializeHandover } from "../src/handover/store.js";
import { identityRouter } from "../src/identity/routes.js";
import { identityStore, initializeIdentity } from "../src/identity/store.js";
import { initializeInventory, inventoryStore } from "../src/inventory/store.js";
import { initializeShipments, shipmentStore } from "../src/shipments/store.js";

test("BOM version pinning, reserve and issue, second-user receipts, partial returns and cancellation", async () => {
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
    store = handoverStore(database);
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
    await initializeHandover(store);
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
    const create = (count) =>
      success(
        call("/handover/requests", "POST", {
          modelId: model.id,
          warehouseId: warehouse.id,
          lineId: line.id,
          count,
        }),
      );
    const document = await create(4);
    assert.equal(document.bomVersionId, firstBom.id);
    assert.equal(document.needs[0].required, "8");
    const newer = await addBom("3");
    const later = await create(4);
    assert.equal(later.needs[0].required, "12");
    assert.equal(later.bomVersionId, newer.id);
    const path = "/handover/requests/" + document.id;
    assert.equal((await call(path)).data.request.needs[0].required, "8");
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
    const stockViewer = await actor("stock-viewer", "whOperator", {
      lineId: line.id,
    });
    const outsideStockViewer = await actor("outside-stock", "whOperator", {
      lineId: otherLine.id,
    });
    assert.equal((await call(path, "GET", undefined, outsider)).status, 403);
    assert.equal(
      (await call("/handover/requests", "GET", undefined, receiver)).data.count,
      2,
    );
    assert.equal(
      (await call("/handover/requests/export", "GET", undefined, receiver))
        .status,
      403,
    );
    const reserve = (path, version, quantity) =>
      call(path + "/reservations", "POST", {
        version,
        cartonCode: carton.code,
        quantity,
      });
    assert.equal(
      (await reserve("/handover/requests/" + later.id, 0, "11")).status,
      409,
    );
    const reservation = await success(reserve(path, 0, "8"));
    assert.equal((await reserve(path, 1, "1")).status, 409);
    assert.equal(
      (
        await call(
          stock + "/reservations/" + reservation.reservation.id + "/release",
          "POST",
          { version: (await call(stock)).data.version },
        )
      ).status,
      409,
    );
    const input = { version: 1, reservationIds: [reservation.reservation.id] };
    const issued = await success(
      call(path + "/deliveries", "POST", input, admin, "issue-1"),
    );
    assert.equal(issued.request.status, "fulfilled");
    const replay = await success(
      call(path + "/deliveries", "POST", input, admin, "issue-1"),
      200,
    );
    assert.equal(replay.delivery.id, issued.delivery.id);
    assert.equal(
      (
        await call(
          path + "/deliveries",
          "POST",
          { ...input, version: 0 },
          admin,
          "issue-1",
        )
      ).status,
      409,
    );
    assert.equal(await store.deliveries.countDocuments(), 1);
    const listed = await call(
      "/handover/deliveries?status=issued&q=" + issued.delivery.code,
      "GET",
      undefined,
      receiver,
    );
    assert.equal(listed.status, 200);
    assert.equal(listed.data.count, 1);
    assert.equal(listed.data.data[0].id, issued.delivery.id);
    assert.equal(listed.data.data[0].requestCode, issued.request.code);
    assert.equal(
      (await call("/handover/deliveries", "GET", undefined, outsider)).data
        .count,
      0,
    );
    assert.equal(
      (await call("/handover/deliveries/export", "GET", undefined, receiver))
        .status,
      403,
    );
    assert.equal((await call("/handover/deliveries/export")).data.count, 1);
    const delivery = "/handover/deliveries/" + issued.delivery.id;
    const item = (await call(path)).data.custody[0];
    assert.equal(item.transit, "8");
    const cartons = "/inventory/carton-stock";
    const cartonQuery = "&warehouseId=" + warehouse.id + "&q=" + carton.code;
    const transitPath = "?account=transit" + cartonQuery;
    const productionPath = "?account=production" + cartonQuery;
    const inTransit = await success(call(cartons + transitPath), 200);
    assert.equal(inTransit.count, 1);
    assert.equal(inTransit.data[0].transit, "8");
    assert.equal(inTransit.data[0].stockSource, "custody");
    assert.equal(inTransit.data[0].lineName, line.name);
    assert.equal((await call(cartons + productionPath)).data.count, 0);
    assert.equal((await call(cartons + "?account=invalid")).status, 400);
    assert.equal(
      (await call(cartons + transitPath, "GET", undefined, outsideStockViewer))
        .data.count,
      0,
    );
    assert.equal(
      (await call(cartons + transitPath, "GET", undefined, stockViewer)).data
        .count,
      1,
    );
    assert.equal(
      (
        await call(
          cartons + "/export" + transitPath,
          "GET",
          undefined,
          stockViewer,
        )
      ).status,
      403,
    );
    assert.deepEqual(
      await success(call(cartons + "/export" + transitPath), 200),
      inTransit,
    );
    const allStock = "?q=" + carton.code;
    const firstStockPage = await success(
      call(cartons + allStock + "&size=1"),
      200,
    );
    const secondStockPage = await success(
      call(cartons + allStock + "&size=1&page=1"),
      200,
    );
    assert.equal(firstStockPage.count, 2);
    assert.equal(secondStockPage.count, 2);
    assert.deepEqual(
      new Set(
        [firstStockPage.data[0], secondStockPage.data[0]].map(
          (row) => row.stockSource ?? row.account,
        ),
      ),
      new Set(["storage", "custody"]),
    );
    const receive = (body, cookie, key) =>
      call(delivery + "/receipts", "POST", body, cookie, key);
    assert.equal(
      (
        await receive(
          { version: 0, items: [{ itemId: item.id, quantity: "8" }] },
          admin,
        )
      ).error.code,
      "ISSUER_CANNOT_RECEIVE",
    );
    assert.equal(
      (await receive({ version: 0, items: [], reason: "missing" }, outsider))
        .status,
      403,
    );
    assert.equal(
      (await receive({ version: 0, items: [] }, receiver)).status,
      400,
    );
    const rejected = await success(
      receive(
        { version: 0, items: [], reason: "نیاز به شمارش دوباره" },
        receiver,
      ),
    );
    assert.equal(rejected.delivery.status, "discrepancy");
    const accepted = {
      version: 1,
      items: [{ itemId: item.id, quantity: "5" }],
      reason: "کسری سه واحد",
    };
    const pairs = await Promise.all([
      receive(accepted, receiver, "rec-1"),
      receive(accepted, receiver, "rec-1"),
    ]);
    assert.deepEqual(pairs.map((row) => row.status).sort(), [200, 201]);
    assert.equal(pairs[0].data.documentId, pairs[1].data.documentId);
    assert.equal(pairs[0].data.delivery.status, "partial");
    assert.equal(
      (await receive(accepted, receiver, "separate-attempt")).status,
      409,
    );
    const recon = () => success(call(stock + "/reconciliation"), 200);
    assert.deepEqual(
      Object.entries(await recon()).filter(([key]) =>
        ["actual", "transit", "line", "balanced"].includes(key),
      ),
      [
        ["actual", "2"],
        ["transit", "3"],
        ["line", "5"],
        ["balanced", true],
      ],
    );
    const inStock = await success(call("/inventory/custody"), 200);
    assert.equal(inStock.data[0].transit, "3");
    assert.equal(inStock.data[0].line, "5");
    const productionStock = await success(call(cartons + productionPath), 200);
    assert.equal(productionStock.count, 1);
    assert.equal(productionStock.data[0].line, "5");
    const returned = await success(
      call(delivery + "/returns", "POST", {
        version: 2,
        source: "transit",
        reason: "بازگشت کسری",
        items: [{ itemId: item.id, quantity: "3" }],
      }),
    );
    assert.equal(returned.request.needs[0].issued, "5");
    assert.equal(returned.request.status, "partial");
    const unused = await success(
      call(delivery + "/returns", "POST", {
        version: 3,
        source: "line",
        reason: "مواد مصرف‌نشده",
        items: [{ itemId: item.id, quantity: "2" }],
      }),
    );
    assert.equal(unused.request.needs[0].issued, "5");
    const final = await recon();
    assert.equal((await call(cartons + transitPath)).data.count, 0);
    assert.equal((await call(cartons + productionPath)).data.data[0].line, "3");
    assert.deepEqual(
      [final.actual, final.transit, final.line, final.balanced],
      ["7", "0", "3", true],
    );

    const afterReturn = (await call(path)).data.request;
    await success(reserve(path, afterReturn.version, "1"));
    const readyToCancel = (await call(path)).data.request;
    const cancelled = await success(
      call(path + "/cancel", "POST", {
        version: readyToCancel.version,
        reason: "اتمام سفارش",
      }),
    );
    assert.equal(cancelled.status, "cancelled");
    assert.equal((await recon()).reserved, "0");
    assert.equal(
      await store.ledger.countDocuments({ documentType: "handover.receive" }),
      1,
    );
    assert.equal(
      await store.ledger.countDocuments({ documentType: "handover.return" }),
      2,
    );

    const complete = await create(1);
    const completePath = "/handover/requests/" + complete.id;
    const held = await success(reserve(completePath, 0, "3"));
    const sent = await success(
      call(completePath + "/deliveries", "POST", {
        version: 1,
        reservationIds: [held.reservation.id],
      }),
    );
    const last = (await call(completePath)).data.custody[0];
    const finishPath = "/handover/deliveries/" + sent.delivery.id + "/receipts";
    const fully = await success(
      call(
        finishPath,
        "POST",
        { version: 0, items: [{ itemId: last.id, quantity: "3" }] },
        receiver,
      ),
    );
    assert.equal(fully.delivery.status, "received");
    assert.equal(
      (
        await call(
          finishPath,
          "POST",
          { version: 1, items: [{ itemId: last.id, quantity: "3" }] },
          receiver,
        )
      ).status,
      409,
    );
    const finalAll = await recon();
    assert.deepEqual(
      [finalAll.actual, finalAll.line, finalAll.balanced],
      ["4", "6", true],
    );
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
