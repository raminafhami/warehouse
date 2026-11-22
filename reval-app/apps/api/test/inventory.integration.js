import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { catalogStore, initializeCatalog } from "../src/catalog/store.js";
import { readConfig } from "../src/config.js";
import { connectDatabase } from "../src/database/connection.js";
import { identityRouter } from "../src/identity/routes.js";
import { identityStore, initializeIdentity } from "../src/identity/store.js";
import { initializeInventory, inventoryStore } from "../src/inventory/store.js";
import { initializeShipments, shipmentStore } from "../src/shipments/store.js";

test("stock custody, rollback, concurrent reservations, adjustment and ledger reconciliation", async () => {
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
  const identity = identityStore(database);
  const store = inventoryStore(database);
  const origin = "http://127.0.0.1:5173";
  const secret = () => randomBytes(16).toString("hex");
  const password = secret();
  const server = createApp({
    isReady: async () => true,
    identity: identityRouter(identity, { origin, ttl: 3600 }),
  }).listen(0, "127.0.0.1");

  try {
    await once(server, "listening");
    await initializeIdentity(identity, {
      REVAL_ADMIN_USERNAME: "stock-admin",
      REVAL_ADMIN_PASSWORD: password,
    });
    await initializeCatalog(catalogStore(database));
    await initializeShipments(shipmentStore(database));
    await initializeInventory(store);
    const base = "http://127.0.0.1:" + server.address().port + "/api/v1";
    let admin;
    async function call(
      path,
      method = "GET",
      body,
      cookie = admin,
      headers = {},
    ) {
      const response = await fetch(base + path, {
        method,
        headers: {
          Origin: origin,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = response.status === 204 ? null : await response.json();
      return {
        status: response.status,
        data: payload?.result,
        error: payload,
        cookie: response.headers.get("set-cookie")?.split(";")[0],
      };
    }
    async function login(username, temporary) {
      const signed = await call(
        "/auth/login",
        "POST",
        { username, password: temporary },
        null,
      );
      assert.equal(signed.status, 200);
      const changed = await call(
        "/auth/password",
        "POST",
        { currentPassword: temporary, newPassword: secret() },
        signed.cookie,
      );
      assert.equal(changed.status, 204);
      return changed.cookie;
    }
    async function add(kind, code, data = {}, parentId) {
      const response = await call("/master/" + kind, "POST", {
        code,
        name: code,
        data,
        parentId,
      });
      assert.equal(response.status, 201, JSON.stringify(response.error));
      return response.data;
    }
    assert.equal((await call("/inventory/balances")).status, 401);
    admin = await login("stock-admin", password);
    const unit = await add("units", "PCS");
    const batteries = await add("partTypes", "BAT", { unitId: unit.id });
    const packs = await add("units", "PACK", { scale: 2, step: "0.25" });
    const boards = await add("partTypes", "BRD", { unitId: packs.id });
    const supplier = await add("suppliers", "SUP-A");
    const a = await add("skus", "BAT-01", {
      partTypeId: batteries.id,
      supplierId: supplier.id,
      specification: "4V",
    });
    const b = await add("skus", "BRD-01", {
      partTypeId: boards.id,
      supplierId: supplier.id,
      specification: "MK",
    });
    const branch = await add("branches", "BR-A");
    const warehouse = await add("warehouses", "WH-A", {}, branch.id);
    const foreignWarehouse = await add("warehouses", "WH-B", {}, branch.id);
    const badLocation = await add(
      "locations",
      "A-01-01-1",
      { allowedPartTypeIds: [batteries.id] },
      warehouse.id,
    );
    const location = await add("locations", "A-01-01-2", {}, warehouse.id);
    const secondLocation = await add(
      "locations",
      "A-01-01-3",
      {},
      warehouse.id,
    );
    const outside = await add(
      "locations",
      "B-01-01-1",
      {},
      foreignWarehouse.id,
    );
    const shipmentResponse = await call("/shipments", "POST", {
      supplierId: supplier.id,
      warehouseId: warehouse.id,
      waybillNumber: "WB-1",
      expectedCartons: 2,
    });
    assert.equal(shipmentResponse.status, 201);
    const shipment = "/shipments/" + shipmentResponse.data.id;
    const pallet = (
      await call(shipment + "/pallets", "POST", { code: "PLT-1405-0001" })
    ).data;
    const first = await call(shipment + "/cartons", "POST", {
      code: "CTN-1405-0001",
      palletId: pallet.id,
      skuId: a.id,
      quantity: "1",
    });
    const second = await call(shipment + "/cartons", "POST", {
      code: "CTN-1405-0002",
      palletId: pallet.id,
      skuId: b.id,
      quantity: "4.25",
    });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    const receive = await call(
      shipment + "/receipts",
      "POST",
      { version: (await call(shipment)).data.shipment.version },
      admin,
      { "Idempotency-Key": "reception" },
    );
    assert.equal(receive.status, 201);
    await store.balances.updateOne(
      { cartonId: first.data.id },
      { $unset: { palletId: "" } },
    );

    async function actor(username, roleId, warehouseId) {
      const initial = secret();
      const response = await call("/users", "POST", {
        username,
        name: username,
        password: initial,
        roleId,
        organizationWide: false,
        scopes: [{ warehouseId }],
      });
      assert.equal(response.status, 201, JSON.stringify(response.error));
      return login(username, initial);
    }
    const manager = await actor("warehouse-manager", "whManager", warehouse.id);
    const operator = await actor(
      "warehouse-operator",
      "whOperator",
      warehouse.id,
    );
    const other = await actor(
      "other-warehouse",
      "whOperator",
      foreignWarehouse.id,
    );
    const initial = await call(
      "/inventory/balances?account=receiving",
      "GET",
      undefined,
      manager,
    );
    assert.equal(initial.data.count, 2);
    assert.equal(
      (await call("/inventory/balances", "GET", undefined, other)).data.count,
      0,
    );
    assert.equal(
      (await call("/inventory/balances/export", "GET", undefined, operator))
        .status,
      403,
    );
    const pallets = await call(
      "/inventory/pallets?q=PLT-1405",
      "GET",
      undefined,
      manager,
    );
    assert.equal(pallets.data.count, 1);
    assert.equal(pallets.data.data[0].items.length, 2);
    const items = pallets.data.data[0].items;
    const palletPath = "/inventory/pallets/" + pallet.id + "/moves";
    assert.equal(
      (
        await call(
          palletPath,
          "POST",
          { items, locationId: badLocation.id },
          manager,
        )
      ).status,
      400,
    );
    assert.equal(
      await store.ledger.countDocuments({ documentType: "inventory.move" }),
      0,
    );
    assert.equal(
      await store.balances.countDocuments({ account: "receiving" }),
      2,
    );
    assert.equal(
      (
        await call(
          palletPath,
          "POST",
          { items, locationId: outside.id },
          manager,
        )
      ).status,
      403,
    );
    const moved = await call(
      palletPath,
      "POST",
      { items, locationId: location.id },
      manager,
    );
    assert.equal(moved.status, 201, JSON.stringify(moved.error));
    assert.equal(
      await store.ledger.countDocuments({ documentId: moved.data.documentId }),
      2,
    );
    assert.equal(
      (await call("/inventory/balances?locationId=" + location.id)).data.count,
      2,
    );
    const cartonPath = "/inventory/cartons/" + first.data.id;
    const before = (await call(cartonPath, "GET", undefined, manager)).data;
    assert.equal(
      (
        await call(
          cartonPath + "/moves",
          "POST",
          { version: before.version, locationId: location.id },
          manager,
        )
      ).status,
      409,
    );
    const single = await call(
      cartonPath + "/moves",
      "POST",
      { version: before.version, locationId: secondLocation.id },
      manager,
    );
    assert.equal(single.status, 201);
    assert.equal(single.data.data[0].palletId, null);
    assert.equal(
      (await call("/inventory/pallets")).data.data[0].items.length,
      1,
    );

    const version = single.data.data[0].version;
    const reserve = (cookie) =>
      call(
        cartonPath + "/reservations",
        "POST",
        { version, quantity: "1" },
        cookie,
      );
    const attempts = await Promise.all([reserve(manager), reserve(operator)]);
    assert.deepEqual(
      attempts.map((result) => result.status).sort(),
      [201, 409],
    );
    const kept = attempts.find((result) => result.status === 201).data;
    assert.equal(kept.balance.available, "0");
    assert.equal(
      await store.reservations.countDocuments({ state: "active" }),
      1,
    );
    const check = () =>
      call(cartonPath + "/reconciliation", "GET", undefined, manager);
    assert.deepEqual((await check()).data, {
      cartonId: first.data.id,
      actual: "1",
      expected: "1",
      reserved: "1",
      expectedReserved: "1",
      balanced: true,
    });
    assert.equal(
      (
        await call(
          cartonPath + "/adjustments",
          "POST",
          { version: kept.balance.version, quantity: "-1", reason: "count" },
          manager,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await call(
          cartonPath + "/adjustments",
          "POST",
          { version: kept.balance.version, quantity: "1", reason: "count" },
          admin,
        )
      ).status,
      403,
    );
    const released = await call(
      cartonPath + "/reservations/" + kept.reservation.id + "/release",
      "POST",
      { version: kept.balance.version },
      operator,
    );
    assert.equal(released.status, 201);
    const adjust = (body) =>
      call(cartonPath + "/adjustments", "POST", body, manager);
    assert.equal(
      (
        await adjust({
          version: released.data.balance.version,
          quantity: "-2",
          reason: "insufficient",
        })
      ).status,
      409,
    );
    assert.equal(
      (await adjust({ version: released.data.balance.version, quantity: "-1" }))
        .status,
      400,
    );
    const adjusted = await adjust({
      version: released.data.balance.version,
      quantity: "-1",
      reason: "کسری شمارش",
    });
    assert.equal(adjusted.status, 201, JSON.stringify(adjusted.error));
    assert.equal(adjusted.data.balance.quantity, "0");
    const reversal = await adjust({
      version: adjusted.data.balance.version,
      reversesId: adjusted.data.adjustment.id,
      reason: "اصلاح شمارش اولیه",
    });
    assert.equal(reversal.status, 201);
    assert.equal(reversal.data.balance.quantity, "1");
    const duplicate = await adjust({
      version: reversal.data.balance.version,
      reversesId: adjusted.data.adjustment.id,
      reason: "تکرار",
    });
    assert.equal(duplicate.status, 409);
    assert.equal((await check()).data.balanced, true);
    const summary = await call(
      "/inventory/summary?warehouseId=" + warehouse.id,
      "GET",
      undefined,
      manager,
    );
    assert.deepEqual(
      summary.data.data.map((item) => [
        item.skuCode,
        item.storage,
        item.reserved,
      ]),
      [
        ["BAT-01", "1", "0"],
        ["BRD-01", "4.25", "0"],
      ],
    );
    const history = await call(
      "/inventory/ledger?adjustments=true",
      "GET",
      undefined,
      manager,
    );
    assert.equal(history.data.count, 2);

    const fractionalPath = "/inventory/cartons/" + second.data.id;
    const fractional = (await call(fractionalPath)).data;
    const reserveFractional = (quantity) =>
      call(
        fractionalPath + "/reservations",
        "POST",
        { version: fractional.version, quantity },
        operator,
      );
    assert.equal((await reserveFractional("0.10")).status, 400);
    const exact = await reserveFractional("0.25");
    assert.equal(exact.status, 201);
    assert.equal(exact.data.balance.available, "4");
    assert.equal(
      (await call(fractionalPath + "/reconciliation")).data.balanced,
      true,
    );

    const cross = await call(
      cartonPath + "/moves",
      "POST",
      { version: reversal.data.balance.version, locationId: outside.id },
      admin,
    );
    assert.equal(cross.status, 201);
    assert.equal(
      (await call(cartonPath + "/reconciliation")).data.balanced,
      true,
    );
    assert.equal(
      (await call(cartonPath, "GET", undefined, manager)).status,
      403,
    );
    assert.equal(
      (await call(cartonPath, "GET", undefined, other)).data.warehouseId,
      foreignWarehouse.id,
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
