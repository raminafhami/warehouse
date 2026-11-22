import { assertContractResponse } from "./support/release-contract.js";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { catalogStore, initializeCatalog } from "../src/catalog/store.js";
import { readConfig } from "../src/config.js";
import { connectDatabase } from "../src/database/connection.js";
import { identityRouter } from "../src/identity/routes.js";
import { identityStore, initializeIdentity } from "../src/identity/store.js";
import { maxWaybillBytes } from "../src/shipments/files.js";
import { initializeShipments, shipmentStore } from "../src/shipments/store.js";

test("shipment scopes, waybill validity, cartoning, receipt replay and quarantine", async () => {
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
  const store = shipmentStore(database);
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
      REVAL_ADMIN_USERNAME: "receipt-admin",
      REVAL_ADMIN_PASSWORD: password,
    });
    await initializeCatalog(catalogStore(database));
    await initializeShipments(store);
    const base = "http://127.0.0.1:" + server.address().port + "/api/v1";
    let admin;

    async function call(
      path,
      method = "GET",
      body,
      { cookie = admin, headers = {} } = {},
    ) {
      const bytes = Buffer.isBuffer(body);
      const response = await fetch(base + path, {
        method,
        headers: {
          Origin: origin,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body && !bytes ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body: bytes ? body : body ? JSON.stringify(body) : undefined,
      });
      const result = response.headers
        .get("content-type")
        ?.includes("application/json")
        ? await response.json()
        : Buffer.from(await response.arrayBuffer());
      if (!Buffer.isBuffer(result))
        assertContractResponse(method, path, response.status, result);
      return {
        status: response.status,
        result: result.result,
        body: result,
        disposition: response.headers.get("content-disposition"),
        cookie: response.headers.get("set-cookie")?.split(";")[0],
      };
    }
    async function login(username, temporary) {
      const logged = await call(
        "/auth/login",
        "POST",
        { username, password: temporary },
        { cookie: null },
      );
      assert.equal(logged.status, 200);
      const changed = await call(
        "/auth/password",
        "POST",
        { currentPassword: temporary, newPassword: secret() },
        { cookie: logged.cookie },
      );
      assert.equal(changed.status, 204);
      return changed.cookie;
    }
    async function add(kind, code, data = {}, parentId) {
      const result = await call("/master/" + kind, "POST", {
        code,
        name: code,
        parentId,
        data,
      });
      assert.equal(result.status, 201, JSON.stringify(result.body));
      return result.result;
    }
    assert.equal((await call("/shipments")).status, 401);
    admin = await login("receipt-admin", password);
    const unit = await add("units", "PCS");
    const part = await add("partTypes", "BAT", { unitId: unit.id });
    const supplier = await add("suppliers", "SUP-A");
    const otherSupplier = await add("suppliers", "SUP-B");
    const sku = await add("skus", "BAT-01", {
      partTypeId: part.id,
      supplierId: supplier.id,
      specification: "4V",
    });
    const foreignSku = await add("skus", "BAT-02", {
      partTypeId: part.id,
      supplierId: otherSupplier.id,
      specification: "4V",
    });
    const branch = await add("branches", "BR-A");
    const warehouse = await add("warehouses", "WH-A", {}, branch.id);
    const outside = await add("warehouses", "WH-B", {}, branch.id);
    const otherPassword = secret();
    const user = await call("/users", "POST", {
      name: "Outside operator",
      username: "outside-operator",
      password: otherPassword,
      roleId: "whOperator",
      organizationWide: false,
      scopes: [{ warehouseId: outside.id }],
    });
    assert.equal(user.status, 201);
    const outsider = await login("outside-operator", otherPassword);

    async function create(
      waybillNumber,
      expectedCartons = 3,
      warehouseId = warehouse.id,
    ) {
      const response = await call("/shipments", "POST", {
        supplierId: supplier.id,
        warehouseId,
        waybillNumber,
        expectedCartons,
      });
      assert.equal(response.status, 201, JSON.stringify(response.body));
      return "/shipments/" + response.result.id;
    }
    const shipment = await create("WB-1");
    const secondShipment = await create("WB-2", 1);
    const thirdShipment = await create("WB-3", 1, outside.id);
    const scopedList = await call("/shipments", "GET", undefined, {
      cookie: outsider,
    });
    assert.equal(scopedList.result.count, 1);
    assert.ok(thirdShipment.endsWith(scopedList.result.data[0].id));
    assert.equal(
      (await call(shipment, "GET", undefined, { cookie: outsider })).status,
      403,
    );
    assert.equal(
      (await call("/shipments/export", "GET", undefined, { cookie: outsider }))
        .status,
      403,
    );

    const file = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/az+S1sAAAAASUVORK5CYII=",
      "base64",
    );
    const upload = (data, type) =>
      call(shipment + "/waybill", "PUT", data, {
        headers: {
          "Content-Type": type,
          "X-Filename": encodeURIComponent("بارنامه.png"),
        },
      });
    assert.equal(
      (await upload(Buffer.from("not a PNG"), "image/png")).status,
      415,
    );
    assert.equal((await upload(file, "application/pdf")).status, 415);
    assert.equal(
      (await upload(Buffer.alloc(maxWaybillBytes + 1), "image/png")).status,
      413,
    );
    assert.equal((await upload(file, "image/png")).status, 200);
    const downloaded = await call(shipment + "/waybill");
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.disposition, /^attachment/);
    assert.deepEqual(downloaded.body, file);
    assert.equal(
      (
        await call(shipment + "/waybill", "GET", undefined, {
          cookie: outsider,
        })
      ).status,
      403,
    );

    const pallet = await call(shipment + "/pallets", "POST", {
      code: "PLT-۱۴۰۵-۰۰۰۱",
    });
    assert.equal(pallet.status, 201);
    assert.equal(pallet.result.code, "PLT-1405-0001");
    assert.equal(
      (await call(shipment + "/pallets", "POST", { code: pallet.result.code }))
        .status,
      409,
    );
    const foreignPallet = await call(secondShipment + "/pallets", "POST", {
      code: "PLT-1405-0002",
    });
    assert.equal(foreignPallet.status, 201);
    const scan = (code, options = {}, path = shipment) =>
      call(path + "/cartons", "POST", {
        code,
        palletId: pallet.result.id,
        skuId: sku.id,
        quantity: "5",
        condition: "accepted",
        ...options,
      });
    assert.equal((await scan("CTN-1405-0010", {}, secondShipment)).status, 400);
    assert.equal(
      (await scan("CTN-1405-0010", { skuId: foreignSku.id })).status,
      400,
    );
    assert.equal((await scan("CTN-1405-0010", { quantity: "0" })).status, 400);
    const first = await scan("CTN-1405-0001");
    assert.equal(first.status, 201);
    const labelPath = shipment + "/labels/" + first.result.code;
    const label = await call(labelPath);
    assert.equal(label.status, 200);
    assert.equal(label.body.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(
      (await call(labelPath, "GET", undefined, { cookie: outsider })).status,
      403,
    );
    assert.equal((await scan("CTN-1405-0001")).status, 409);
    assert.equal(
      (
        await scan(
          "CTN-1405-0001",
          { palletId: foreignPallet.result.id },
          secondShipment,
        )
      ).status,
      409,
    );
    const second = await scan("CTN-1405-0002", {
      quantity: "2",
      condition: "quarantine",
    });
    assert.equal(second.status, 201);
    const removable = await scan("CTN-1405-0003");
    assert.equal(removable.status, 201);
    assert.equal(
      (await call(shipment + "/cartons/" + removable.result.id, "DELETE"))
        .status,
      200,
    );
    assert.equal(await store.balances.countDocuments(), 0);

    const open = (await call(shipment)).result.shipment;
    const confirm = (key, payload, path = shipment) =>
      call(path + "/receipts", "POST", payload, {
        headers: { "Idempotency-Key": key },
      });
    assert.equal(
      (await confirm("missing-reason", { version: open.version })).status,
      400,
    );
    const payload = {
      version: open.version,
      reason: "کسری یک کارتن و قرنطینهٔ یک کارتن",
    };
    const replies = await Promise.all([
      confirm("receipt-1", payload),
      confirm("receipt-1", payload),
    ]);
    assert.deepEqual(replies.map((result) => result.status).sort(), [200, 201]);
    assert.equal(replies[0].result.id, replies[1].result.id);
    assert.equal(
      (await confirm("receipt-1", payload)).result.id,
      replies[0].result.id,
    );
    assert.equal(
      (await confirm("receipt-1", { ...payload, reason: "different" })).status,
      409,
    );
    assert.equal(
      (await confirm("receipt-1", payload, secondShipment)).status,
      409,
    );
    assert.equal(await store.receipts.countDocuments(), 1);
    assert.equal(await store.ledger.countDocuments(), 2);
    const balances = await store.balances.find().sort({ account: 1 }).toArray();
    assert.deepEqual(
      balances.map((item) => [
        item.account,
        item.quantity.toString(),
        item.reserved.toString(),
      ]),
      [
        ["quarantine", "2", "0"],
        ["receiving", "5", "0"],
      ],
    );
    const warehouseStock =
      "/inventory/carton-stock?warehouseId=" + warehouse.id;
    const materials = await call(warehouseStock + "&zone=materials");
    const quarantined = await call(warehouseStock + "&account=quarantine");
    assert.equal(materials.status, 200);
    assert.equal(quarantined.status, 200);
    assert.deepEqual(
      materials.result.data.map((row) => row.account),
      ["receiving"],
    );
    assert.deepEqual(
      quarantined.result.data.map((row) => row.account),
      ["quarantine"],
    );
    assert.equal(
      (await call(warehouseStock + "&zone=materials&account=quarantine"))
        .status,
      400,
    );
    assert.equal(
      (await call(shipment + "/cartons/" + first.result.id, "DELETE")).status,
      409,
    );
    const refreshed = (await call(shipment)).result;
    assert.equal(refreshed.shipment.status, "discrepancy");
    assert.equal(refreshed.shipment.discrepancy.countDifference, -1);
    assert.equal(refreshed.cartons.length, 2);
    const scopedReaderPassword = secret();
    const reader = await call("/users", "POST", {
      name: "Same warehouse",
      username: "same-warehouse",
      password: scopedReaderPassword,
      roleId: "whOperator",
      organizationWide: false,
      scopes: [{ warehouseId: warehouse.id }],
    });
    assert.equal(reader.status, 201);
    const secondDevice = await login("same-warehouse", scopedReaderPassword);
    assert.equal(
      (await call(shipment, "GET", undefined, { cookie: secondDevice })).result
        .receipts[0].id,
      replies[0].result.id,
    );
    assert.equal(
      (
        await call(shipment + "/receipts", "POST", payload, {
          cookie: secondDevice,
          headers: { "Idempotency-Key": "denied" },
        })
      ).status,
      403,
    );

    const additional = await scan("CTN-1405-0003");
    assert.equal(additional.status, 201);
    assert.equal(additional.result.id, removable.result.id);
    const beforeSecond = (await call(shipment)).result.shipment;
    assert.equal(
      (
        await confirm("receipt-2", {
          version: beforeSecond.version,
          reason: "کارتن کسری رسید؛ قرنطینه باقی است",
        })
      ).status,
      201,
    );
    const resolved = (await call(shipment)).result.shipment;
    const closure = await call(shipment + "/discrepancy/resolution", "POST", {
      version: resolved.version,
      reason: "اختلاف ثبت و قرنطینه تحویل مسئول مربوط شد",
    });
    assert.equal(closure.status, 200);
    assert.equal(closure.result.status, "approved");
    assert.equal(await store.ledger.countDocuments(), 3);
    assert.equal(
      await store.balances.countDocuments({ account: "quarantine" }),
      1,
    );
    assert.equal((await scan("CTN-1405-0004")).status, 409);

    const empty = (await call(secondShipment)).result.shipment;
    assert.equal(
      (
        await confirm(
          "empty-pallet",
          { version: empty.version },
          secondShipment,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await scan(
          "CTN-1405-0004",
          { palletId: foreignPallet.result.id },
          secondShipment,
        )
      ).status,
      201,
    );
    assert.equal(
      (
        await confirm(
          "stale-version",
          { version: empty.version },
          secondShipment,
        )
      ).status,
      409,
    );
    const complete = (await call(secondShipment)).result.shipment;
    const normal = await confirm(
      "complete",
      { version: complete.version },
      secondShipment,
    );
    assert.equal(normal.status, 201);
    assert.equal(normal.result.status, "approved");
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
