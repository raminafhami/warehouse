import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ObjectId } from "mongodb";
import { catalogStore } from "../src/catalog/store.js";
import { readConfig, readIdentityOptions } from "../src/config.js";
import { connectDatabase } from "../src/database/connection.js";
import { shipmentStore } from "../src/shipments/store.js";

const config = readConfig(process.env);
const { origin } = readIdentityOptions(process.env);
const password = process.env.REVAL_DEMO_PASSWORD;
const [snapshotPath, referencePath] = process.argv.slice(2);
if (
  !config.allowDemoSeed ||
  process.env.NODE_ENV !== "test" ||
  config.host !== "127.0.0.1" ||
  !/^mongodb:\/\/127\.0\.0\.1:\d+\/reval_test(?:_[a-z0-9]+)?\?/.test(
    config.uri,
  ) ||
  !password ||
  !snapshotPath ||
  !referencePath
)
  throw new Error(
    "Use a local test database, the demo password, the redacted seed snapshot and REVAL.html.",
  );

const hash = (value) => createHash("sha256").update(value).digest("hex");
const sourceHash = hash(await readFile(referencePath));
if (
  sourceHash !==
  "c8192697f27300a1756813e251ab7d0f7d932a81e12a56bf14980b1cb3229901"
)
  throw new Error("The supplied HTML differs from the approved P00 reference.");
const raw = await readFile(snapshotPath, "utf8");
const source = JSON.parse(raw);
const sections = Object.entries(source).filter(([, rows]) =>
  Array.isArray(rows),
);
if (
  !sections.length ||
  !source.shipments?.length ||
  /"(?:password|passwordHash|passwd|pass|pwd|token|secret|apiKey)"\s*:\s*"(?!\[REDACTED\])/i.test(
    raw,
  )
)
  throw new Error("Expected a redacted P00 data snapshot.");

const db = await connectDatabase(config.uri);
const catalog = catalogStore(db);
const stock = shipmentStore(db);
const archive = db.db.collection("reval_reference_snapshot");
const base = "http://127.0.0.1:" + config.port + "/api/v1";
let cookie;
const tally = {};
const issues = [];

async function call(path, body, operation = path) {
  const headers = { Origin: origin };
  if (cookie) headers.Cookie = cookie;
  if (body) {
    headers["Content-Type"] = "application/json";
    headers["Idempotency-Key"] = hash(sourceHash + ":" + operation);
  }
  const response = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers,
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 204) return;
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(
      path + " HTTP " + response.status + " " + data.message,
    );
    error.code = data.code;
    throw error;
  }
  if (path === "/auth/login")
    cookie = response.headers.get("set-cookie").split(";")[0];
  return data.result;
}

async function add(kind, code, name, data = {}, parentId = null) {
  const row = await catalog.records.findOne({ kind, code, parentId });
  if (row) return String(row._id);
  return (
    await call("/master/" + kind, {
      code,
      name,
      data,
      ...(parentId ? { parentId } : {}),
    })
  ).id;
}

function lookup(map, key) {
  const id = map.get(key);
  if (!id) throw new Error("Missing reference " + key);
  return id;
}

async function mapRows(
  rows,
  operation,
  key = (row) => row.id,
  label = "records",
) {
  const mapped = new Map();
  for (const row of rows) {
    try {
      mapped.set(key(row), await operation(row));
    } catch (error) {
      issues.push({ section: label, id: key(row), reason: error.message });
    }
  }
  tally[label] = mapped.size;
  return mapped;
}

async function publish(body, revision = 1) {
  const filter = {
    type: body.type,
    modelId: body.modelId,
    lineId: body.lineId ?? null,
    revision,
  };
  if (await catalog.versions.findOne(filter)) return;
  await call("/master/versions", body);
}

try {
  await call("/auth/login", { username: "demo-reval", password });
  await archive.bulkWrite(
    sections.map(([name, rows]) => ({
      replaceOne: {
        filter: { _id: name },
        replacement: { _id: name, rows, count: rows.length, sourceHash },
        upsert: true,
      },
    })),
  );
  const branch = await add("branches", "REVAL-REFERENCE", "کارخانه مرجع REVAL");
  const units = new Map([
    ["عدد", await add("units", "REF-PCS", "عدد")],
    ["بسته", await add("units", "REF-PACK", "بسته")],
  ]);
  const typeIds = await mapRows(
    source.partTypes,
    (row) =>
      add("partTypes", row.code, row.name, {
        unitId: lookup(units, row.unit),
        category: row.category,
        serialTracking: row.serialized,
        minLineStock: row.minLine,
      }),
    (row) => row.code,
    "partTypes",
  );
  const suppliers = await mapRows(
    source.suppliers,
    (row) => add("suppliers", row.code, row.name, { country: row.country }),
    undefined,
    "suppliers",
  );
  const skus = await mapRows(
    source.skus,
    (row) =>
      add("skus", row.code, row.name, {
        partTypeId: lookup(typeIds, row.partType),
        supplierId: lookup(suppliers, row.supplierId),
        specification: row.spec || row.name,
      }),
    (row) => row.code,
    "skus",
  );
  const purposes = {
    raw: "materials",
    fg: "finished",
    defect: "defects",
    line: "line",
    quarantine: "quarantine",
  };
  const warehouses = await mapRows(
    source.warehouses,
    (row) =>
      add(
        "warehouses",
        row.code,
        row.name,
        { purpose: purposes[row.kind] },
        branch,
      ),
    undefined,
    "warehouses",
  );
  const positions = await mapRows(
    source.locations,
    (row) => {
      const locationCode = /^[A-Z][A-Z0-9]*-\d{2}-\d{2}-\d{1,2}$/.test(row.code)
        ? row.code
        : [
            row.zone,
            String(row.row || 0).padStart(2, "0"),
            String(row.shelf || 0).padStart(2, "0"),
            row.level || "1",
          ].join("-");
      return add(
        "locations",
        locationCode,
        row.code,
        {},
        lookup(warehouses, row.warehouseId),
      );
    },
    (row) => row.warehouseId + ":" + row.code,
    "locations",
  );
  const lines = await mapRows(
    source.lines,
    (row) => add("lines", row.code, row.name, {}, branch),
    undefined,
    "lines",
  );
  const colors = new Map();
  for (const name of new Set(source.models.flatMap((row) => row.colors)))
    colors.set(
      name,
      await add("colors", "REF-" + hash(name).slice(0, 8).toUpperCase(), name),
    );
  const models = await mapRows(
    source.models,
    (row) =>
      add("models", row.code, row.name, {
        brand: row.brand,
        specification: row.desc,
        colorIds: row.colors.map((name) => lookup(colors, name)),
        imeiSlots: 2,
      }),
    undefined,
    "models",
  );
  const tests = await mapRows(
    source.tests,
    (row) =>
      add("tests", row.id, row.name, {
        results: ["قبول", "رد", "نیازمند بررسی"],
        ...(typeIds.has(row.partType)
          ? { partTypeId: typeIds.get(row.partType) }
          : {}),
      }),
    undefined,
    "tests",
  );
  const definitions = new Map(
    [...source.stations].reverse().map((row) => [row.code, row]),
  );
  const stationRows = source.lines.flatMap((line) =>
    [...definitions.values()].map((row) => ({ ...row, line: line.id })),
  );
  const stations = await mapRows(
    stationRows,
    (row) =>
      add(
        "stations",
        row.code,
        row.title,
        {
          order: Number(row.code.slice(3)),
          operation: row.opType,
          maxRetests: row.maxRetries,
          testIds: row.tests.map((id) => lookup(tests, id)),
          requirements: row.checks,
          allowedRoleIds: ["assemblyOperator", "stOp" + row.code.slice(3)],
        },
        lookup(lines, row.line),
      ),
    (row) => row.line + ":" + row.code,
    "stations",
  );
  await mapRows(
    source.models.flatMap((model) =>
      model.boms.map((row) => ({
        ...row,
        model,
        id: model.id + ":" + row.version,
      })),
    ),
    (row) =>
      publish(
        {
          type: "bom",
          modelId: lookup(models, row.model.id),
          description: row.note,
          lines: row.items.map((item) => ({
            skuId: lookup(skus, item.sku),
            quantity: String(item.qty),
            stationCode: item.stationCode,
          })),
        },
        row.version,
      ),
    undefined,
    "bomVersions",
  );
  await mapRows(
    source.lines.flatMap((line) =>
      source.models.map((model) => ({
        line,
        model,
        id: line.id + ":" + model.id,
      })),
    ),
    ({ line, model }) =>
      publish({
        type: "routing",
        modelId: lookup(models, model.id),
        lineId: lookup(lines, line.id),
        stationIds: source.stations
          .filter((row) => row.modelId === model.id)
          .sort((a, b) => a.order - b.order)
          .map((row) => lookup(stations, line.id + ":" + row.code)),
      }),
    undefined,
    "routingVersions",
  );

  const rawWarehouse = lookup(warehouses, "WH-RM");
  await mapRows(
    [...source.shipments].reverse(),
    async (row) => {
      const existing = await stock.shipments.findOne({
        waybillNumber: row.waybill,
        warehouseId: rawWarehouse,
      });
      const id = existing
        ? String(existing._id)
        : (
            await call("/shipments", {
              supplierId: lookup(suppliers, row.supplierId),
              warehouseId: rawWarehouse,
              waybillNumber: row.waybill,
              purchaseOrder: row.po,
              expectedCartons: row.expectedCartons,
              notes: row.note,
            })
          ).id;
      const path = "/shipments/" + id;
      const detail = await call(path);
      const pallets = source.pallets.filter(
        (item) => item.shipmentId === row.id,
      );
      const cartons = source.cartons.filter(
        (item) => item.shipmentId === row.id,
      );
      if (detail.shipment.status === "receiving") {
        for (const pallet of pallets) {
          const saved =
            detail.pallets.find((item) => item.code === pallet.id) ??
            (await call(path + "/pallets", { code: pallet.id }));
          for (const carton of cartons.filter(
            (item) => item.palletId === pallet.id,
          )) {
            if (detail.cartons.some((item) => item.code === carton.id))
              continue;
            await call(path + "/cartons", {
              palletId: saved.id,
              code: carton.id,
              skuId: lookup(skus, carton.sku),
              quantity: String(carton.initialQty),
              lot: carton.batch,
              condition:
                carton.scope === "quarantine" ? "quarantine" : "accepted",
            });
          }
        }
        const current = await call(path);
        await call(
          path + "/receipts",
          {
            version: current.shipment.version,
            reason: row.discrepancy?.note ?? "",
          },
          row.id + ":receipt",
        );
      }
      await stock.shipments.updateOne(
        { _id: new ObjectId(id), waybillNumber: row.waybill },
        {
          $set: { code: row.id, createdAt: new Date(row.date) },
        },
      );
      return id;
    },
    undefined,
    "shipments",
  );

  await mapRows(
    source.cartons.filter((row) => row.scope === "warehouse"),
    async (row) => {
      const carton = await stock.cartons.findOne({ code: row.id });
      if (!carton) throw new Error("Carton was not received");
      const balance = await stock.balances.findOne({
        cartonId: String(carton._id),
        account: "receiving",
      });
      if (!balance) return;
      await call(
        "/inventory/cartons/" + carton._id + "/moves",
        {
          version: balance.version,
          locationId: lookup(positions, "WH-RM:" + row.location),
        },
        row.id + ":position",
      );
    },
    undefined,
    "placedCartons",
  );

  tally.operationalImeis = 0;
  for (const model of source.models) {
    const rows = source.imeis.filter(
      (row) => row.modelId === model.id && row.status === "free",
    );
    if (!rows.length) continue;
    try {
      const result = await call(
        "/imei/imports",
        {
          modelId: lookup(models, model.id),
          source: rows[0].pool,
          rows: rows.map((row, index) => ({
            row: index + 1,
            cells: [row.imei, row.imei2],
          })),
        },
        model.id + ":imei-pool",
      );
      tally.operationalImeis += result.accepted;
      for (const error of result.errors)
        issues.push({
          section: "imeis",
          id: model.id + ":" + error.row,
          reason: error.code,
        });
    } catch (error) {
      issues.push({ section: "imeis", id: model.id, reason: error.message });
    }
  }
  await mapRows(
    source.orders,
    async (row) => {
      const order = await call(
        "/imei/orders",
        {
          modelId: lookup(models, row.modelId),
          lineId: lookup(lines, row.lineId),
          colorId: lookup(colors, row.color),
          count: row.qty,
        },
        row.id,
      );
      await db.db
        .collection("reval_production_orders")
        .updateOne(
          { _id: new ObjectId(order.id) },
          { $set: { code: row.id, at: new Date(row.date) } },
        );
    },
    undefined,
    "orders",
  );
  const requests = await mapRows(
    source.requests.filter((row) => ["open", "issued"].includes(row.status)),
    async (row) => {
      const request = await call(
        "/handover/requests",
        {
          modelId: lookup(models, row.modelId),
          lineId: lookup(lines, row.lineId),
          warehouseId: rawWarehouse,
          count: row.phones,
        },
        row.id,
      );
      await db.db
        .collection("reval_material_requests")
        .updateOne(
          { _id: new ObjectId(request.id) },
          { $set: { code: row.id, at: new Date(row.date) } },
        );
      return request.id;
    },
    undefined,
    "requests",
  );
  await mapRows(
    source.deliveries.filter((row) => row.status === "issued"),
    async (row) => {
      const requestId = lookup(requests, row.requestId);
      const path = "/handover/requests/" + requestId;
      const deliveries = db.db.collection("reval_material_deliveries");
      const existing = await deliveries.findOne({ code: row.id, requestId });
      if (existing) return;
      const cartonIds = [];
      const reservations = [];
      for (const code of row.cartonIds) {
        const fixture = source.cartons.find((item) => item.id === code);
        const pallet = source.pallets.find(
          (item) => item.id === fixture.palletId,
        );
        const carton = await stock.cartons.findOne({ code });
        if (!carton) throw new Error("Unreceived carton " + code);
        cartonIds.push(String(carton._id));
        const balance = await stock.balances.findOne({
          cartonId: String(carton._id),
          account: "receiving",
        });
        if (balance)
          await call(
            "/inventory/cartons/" + carton._id + "/moves",
            {
              version: balance.version,
              locationId: lookup(positions, "WH-RM:" + pallet.location),
            },
            row.id + ":" + code + ":position",
          );
        const detail = await call(path);
        const prior = detail.reservations.find(
          (item) => item.cartonCode === code,
        );
        if (prior) {
          reservations.push(prior.id);
        } else if (!detail.custody.some((item) => item.cartonCode === code)) {
          const reserved = await call(
            path + "/reservations",
            {
              version: detail.request.version,
              cartonCode: code,
              quantity: String(fixture.initialQty),
            },
            row.id + ":" + code + ":reserve",
          );
          reservations.push(reserved.reservation.id);
        }
      }
      const detail = await call(path);
      const replayed = detail.deliveries.find((item) =>
        cartonIds.every((id) =>
          detail.custody.some(
            (custody) =>
              custody.cartonId === id && custody.deliveryId === item.id,
          ),
        ),
      );
      const id =
        replayed?.id ??
        (
          await call(
            path + "/deliveries",
            {
              version: detail.request.version,
              reservationIds: reservations,
            },
            row.id + ":issue",
          )
        ).delivery.id;
      await deliveries.updateOne(
        { _id: new ObjectId(id), requestId },
        {
          $set: { code: row.id, at: new Date(row.time) },
        },
      );
    },
    undefined,
    "issuedDeliveries",
  );
  const counts = Object.fromEntries(
    sections.map(([name, rows]) => [name, rows.length]),
  );
  const result = { sourceHash, counts, operational: tally, issues };
  await archive.replaceOne(
    { _id: "_summary" },
    { _id: "_summary", ...result },
    { upsert: true },
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (cookie) await call("/auth/logout", {}).catch(() => {});
  await db.close();
}
