import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { checkLocationCompatibility } from "../src/catalog/records.js";
import { catalogStore, initializeCatalog } from "../src/catalog/store.js";
import { connectDatabase } from "../src/database/connection.js";
import { identityRouter } from "../src/identity/routes.js";
import { identityStore, initializeIdentity } from "../src/identity/store.js";

test("catalog uniqueness, scope, barcode and immutable BOM and routing snapshots", async () => {
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
  const origin = "http://127.0.0.1:5173";
  const store = identityStore(database);
  const catalog = catalogStore(database);
  const secret = () => randomBytes(16).toString("hex");
  const first = secret();
  const next = secret();
  await initializeIdentity(store, {
    REVAL_ADMIN_USERNAME: "catalog-admin",
    REVAL_ADMIN_PASSWORD: first,
  });
  await initializeCatalog(catalog);
  const server = createApp({
    isReady: async () => true,
    identity: identityRouter(store, { origin, ttl: 3600 }),
  }).listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const base = "http://127.0.0.1:" + server.address().port + "/api/v1";
    let admin;
    async function call(path, method = "GET", data, cookie = admin) {
      const response = await fetch(base + path, {
        method,
        headers: {
          Origin: origin,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(data ? { "Content-Type": "application/json" } : {}),
        },
        body: data ? JSON.stringify(data) : undefined,
      });
      const contentType = response.headers.get("content-type");
      const body = contentType?.includes("json")
        ? await response.json()
        : contentType?.includes("png")
          ? Buffer.from(await response.arrayBuffer())
          : null;
      return {
        status: response.status,
        data: body?.result,
        code: body?.code,
        message: body?.message,
        body,
        cookie: response.headers.get("set-cookie")?.split(";")[0],
      };
    }
    async function login(username, temporary, password) {
      const login = await call(
        "/auth/login",
        "POST",
        { username, password: temporary },
        null,
      );
      assert.equal(login.status, 200);
      const changed = await call(
        "/auth/password",
        "POST",
        { currentPassword: temporary, newPassword: password },
        login.cookie,
      );
      assert.equal(changed.status, 204);
      return changed.cookie;
    }
    assert.equal((await call("/master/skus")).status, 401);
    admin = await login("catalog-admin", first, next);
    const create = (kind, code, data = {}, parentId) =>
      call("/master/" + kind, "POST", { code, name: code, data, parentId });
    async function add(...args) {
      const result = await create(...args);
      assert.equal(result.status, 201, JSON.stringify(result.body));
      return result.data;
    }
    const unit = await add("units", "PCS");
    const type = await add("partTypes", "BAT", { unitId: unit.id });
    const supplier = await add("suppliers", "SUP-A");
    const sku = await add("skus", "BAT-01", {
      partTypeId: type.id,
      supplierId: supplier.id,
      specification: "4V",
    });
    assert.equal(
      (
        await create("skus", "bat-01", {
          partTypeId: type.id,
          supplierId: supplier.id,
          specification: "4V",
        })
      ).status,
      409,
    );

    const branch = await add("branches", "BR-A");
    const otherBranch = await add("branches", "BR-B");
    const line = await add("lines", "L-1", {}, branch.id);
    const otherLine = await add("lines", "L-1", {}, otherBranch.id);
    const testDef = await add("tests", "TEST-1", {
      results: ["pass", "fail"],
      partTypeId: type.id,
    });
    const station = await add(
      "stations",
      "ST-1",
      { order: 1, maxRetests: 1, testIds: [testDef.id] },
      line.id,
    );
    const outsideStation = await add(
      "stations",
      "ST-2",
      { order: 1 },
      otherLine.id,
    );
    const extraStation = await add("stations", "ST-2", { order: 2 }, line.id);
    const otherLineFirst = await add(
      "stations",
      "ST-1",
      { order: 1 },
      otherLine.id,
    );
    const color = await add("colors", "BLK");
    const model = await add("models", "TA-130", {
      colorIds: [color.id],
      imeiSlots: 2,
    });
    const badModel = await create("models", "TA-999", {
      colorIds: [supplier.id],
      imeiSlots: 2,
    });
    assert.equal(badModel.status, 400);
    assert.match(badModel.message, /رنگ/);

    const warehouse = await add(
      "warehouses",
      "WH-RM",
      { purpose: "مواد" },
      branch.id,
    );
    const noWarehouse = await create("locations", "A-02-03-2", {}, model.id);
    assert.equal(noWarehouse.status, 400);
    assert.match(noWarehouse.message, /انبار/);
    const badLocation = await create("locations", "INVALID", {}, warehouse.id);
    assert.match(badLocation.message, /فرمت موقعیت/);
    const goodLocation = await add(
      "locations",
      "A-02-03-2",
      { allowedModelIds: [model.id], allowedPartTypeIds: [type.id] },
      warehouse.id,
    );
    checkLocationCompatibility(goodLocation, {
      modelId: model.id,
      partTypeId: type.id,
    });
    assert.throws(
      () =>
        checkLocationCompatibility(goodLocation, {
          modelId: color.id,
          partTypeId: type.id,
        }),
      /مجاز نیست/,
    );
    const label = await call(
      "/master/locations/" + goodLocation.id + "/barcode",
    );
    assert.equal(label.status, 200);
    assert.equal(label.body.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");

    const bom = (count) =>
      call("/master/versions", "POST", {
        type: "bom",
        modelId: model.id,
        lines: [{ skuId: sku.id, quantity: count, stationCode: station.code }],
      });
    const route = (stationIds) =>
      call("/master/versions", "POST", {
        type: "routing",
        modelId: model.id,
        lineId: line.id,
        stationIds,
      });
    assert.equal((await bom("1.5")).status, 400);
    const original = await bom("1");
    assert.equal(original.status, 201, JSON.stringify(original.body));
    assert.equal((await bom("1")).code, "NO_VERSION_CHANGE");
    assert.equal((await route([outsideStation.id])).status, 400);
    const firstRoute = await route([station.id, extraStation.id]);
    assert.equal(firstRoute.status, 201, JSON.stringify(firstRoute.body));
    assert.equal(
      firstRoute.data.steps[0].configuration.tests[0].code,
      testDef.code,
    );
    assert.equal(
      (
        await call("/master/versions", "POST", {
          type: "routing",
          modelId: model.id,
          lineId: otherLine.id,
          stationIds: [otherLineFirst.id, outsideStation.id],
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await call("/master/skus/" + sku.id, "PATCH", {
          version: sku.version,
          active: false,
        })
      ).code,
      "CATALOG_IN_USE",
    );
    const revised = await bom("2");
    assert.equal(revised.data.revision, 2);
    assert.equal(
      (await call("/master/versions/" + original.data.id)).data.lines[0]
        .quantity,
      "1",
    );

    const parallel = await Promise.all([bom("3"), bom("4")]);
    assert.deepEqual(
      parallel.map((result) => result.data.revision).sort(),
      [3, 4],
    );
    const stationEdit = await call("/master/stations/" + station.id, "PATCH", {
      version: station.version,
      name: station.name,
      data: { ...station.data, maxRetests: 3 },
    });
    assert.equal(stationEdit.status, 200);
    const laterRoute = await route([station.id]);
    assert.equal(laterRoute.status, 201);
    assert.equal(laterRoute.data.steps[0].configuration.maxRetests, 3);
    assert.equal(
      (await call("/master/versions/" + firstRoute.data.id)).data.steps[0]
        .configuration.maxRetests,
      1,
    );
    assert.equal(
      (await call("/master/models/" + model.id, "DELETE")).status,
      404,
    );
    const replacementSku = await add("skus", "BAT-02", {
      partTypeId: type.id,
      supplierId: supplier.id,
      specification: "4V",
    });
    const replacement = await call("/master/versions", "POST", {
      type: "bom",
      modelId: model.id,
      lines: [
        { skuId: replacementSku.id, quantity: "1", stationCode: station.code },
      ],
    });
    assert.equal(replacement.data.revision, 5);
    assert.equal(
      (
        await call("/master/skus/" + sku.id, "PATCH", {
          version: sku.version,
          active: false,
        })
      ).status,
      200,
    );
    assert.equal(
      (await call("/master/versions/" + original.data.id)).data.lines[0].skuId,
      sku.id,
    );
    const changeStatus = (kind, item, active) =>
      call("/master/" + kind + "/" + item.id, "PATCH", {
        version: item.version,
        active,
      });
    assert.equal(
      (await changeStatus("partTypes", type, false)).code,
      "CATALOG_IN_USE",
    );
    const extraType = await add("partTypes", "AUX", { unitId: unit.id });
    await add("skus", "AUX-01", {
      partTypeId: extraType.id,
      supplierId: supplier.id,
      specification: "Auxiliary",
    });
    const skuFilter = "?q=01&partTypeId=" + type.id;
    const filteredSkus = await call("/master/skus" + skuFilter);
    assert.equal(filteredSkus.status, 200);
    assert.equal(filteredSkus.data.count, 1);
    assert.equal(filteredSkus.data.data[0].id, sku.id);
    assert.equal(filteredSkus.data.data[0].active, false);
    const skuExport = await call("/master/skus/export" + skuFilter);
    assert.deepEqual(skuExport.data, filteredSkus.data);
    const skuPage = await call(
      "/master/skus?size=1&page=1&partTypeId=" + type.id,
    );
    assert.equal(skuPage.data.count, 2);
    assert.deepEqual(
      skuPage.data.data.map((item) => item.id),
      [replacementSku.id],
    );
    assert.equal((await call("/master/skus?partTypeId=invalid")).status, 400);
    assert.equal(
      (await call("/master/stations?partTypeId=" + type.id)).status,
      400,
    );
    assert.equal((await call("/master/skus?modelId=" + model.id)).status, 400);

    const stationFilter = "?modelId=" + model.id;
    const filteredStations = await call("/master/stations" + stationFilter);
    assert.equal(filteredStations.status, 200);
    assert.equal(filteredStations.data.count, 3);
    assert.deepEqual(
      new Set(filteredStations.data.data.map((item) => item.id)),
      new Set([station.id, otherLineFirst.id, outsideStation.id]),
    );
    const stationSearch = stationFilter + "&q=ST-2";
    const filteredStationSearch = await call(
      "/master/stations" + stationSearch,
    );
    assert.deepEqual(
      filteredStationSearch.data.data.map((item) => item.id),
      [outsideStation.id],
    );
    assert.deepEqual(
      (await call("/master/stations/export" + stationSearch)).data,
      filteredStationSearch.data,
    );
    assert.equal((await call("/master/stations?modelId=invalid")).status, 400);
    assert.equal(
      (await call("/master/stations?modelId=" + color.id)).data.count,
      0,
    );
    const unusedType = await add("partTypes", "IDLE", { unitId: unit.id });
    assert.equal(
      (await changeStatus("partTypes", unusedType, false)).data.active,
      false,
    );
    const extraSupplier = await add("suppliers", "SUP-B");
    assert.equal(
      (await changeStatus("suppliers", extraSupplier, false)).data.active,
      false,
    );
    const archivedModel = await changeStatus("models", model, false);
    assert.equal(archivedModel.data.active, false);
    assert.equal(
      (await call("/master/versions/" + original.data.id)).status,
      200,
    );

    const operatorPassword = secret();
    const wrongScope = await call("/users", "POST", {
      name: "Conflicting scope",
      username: "conflicting-scope",
      password: operatorPassword,
      roleId: "whManager",
      organizationWide: false,
      scopes: [{ branchId: branch.id, lineId: otherLine.id }],
    });
    assert.equal(wrongScope.status, 400);
    const operator = await call("/users", "POST", {
      name: "Warehouse manager",
      username: "warehouse-manager",
      password: operatorPassword,
      roleId: "whManager",
      organizationWide: false,
      scopes: [{ branchId: branch.id }],
    });
    assert.equal(operator.status, 201);
    const reader = await login("warehouse-manager", operatorPassword, secret());
    const scoped = await call("/master/lines", "GET", undefined, reader);
    assert.deepEqual(
      scoped.data.data.map((item) => item.id),
      [line.id],
    );
    const scopedStations = await call(
      "/master/stations" + stationFilter,
      "GET",
      undefined,
      reader,
    );
    assert.equal(scopedStations.data.count, 1);
    assert.deepEqual(
      scopedStations.data.data.map((item) => item.id),
      [station.id],
    );
    assert.equal(
      (await call("/master/lines/" + otherLine.id, "GET", undefined, reader))
        .status,
      403,
    );
    assert.equal(
      (await call("/master/skus/export", "GET", undefined, reader)).status,
      403,
    );
    assert.equal(
      (
        await call(
          "/master/skus",
          "POST",
          { code: "OTHER", name: "OTHER" },
          reader,
        )
      ).status,
      403,
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
