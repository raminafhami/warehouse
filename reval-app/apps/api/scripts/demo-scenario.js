import { createHash } from "node:crypto";
import { readConfig, readIdentityOptions } from "../src/config.js";
import { connectDatabase } from "../src/database/connection.js";
import { catalogStore } from "../src/catalog/store.js";
import { shipmentStore } from "../src/shipments/store.js";
import { identityStore } from "../src/identity/store.js";

const config = readConfig(process.env);
const { origin } = readIdentityOptions(process.env);
const password = process.env.REVAL_DEMO_PASSWORD;
if (
  !config.allowDemoSeed ||
  process.env.NODE_ENV !== "test" ||
  config.host !== "127.0.0.1" ||
  !password
)
  throw new Error(
    "Use a loopback API, a test database, ALLOW_DEMO_SEED=true and REVAL_DEMO_PASSWORD.",
  );

const base = "http://127.0.0.1:" + config.port + "/api/v1";
const database = await connectDatabase(config.uri);
const catalog = catalogStore(database);
const stock = shipmentStore(database);
const cookies = new Map();
const admin = "demo-reval";
const basketActor = "demo-basket";
const assemblyActor = "demo-assembly";
const defectsActor = "demo-defects";
const fixture = "reval-reference-v1";

async function send(actor, path, body, operation) {
  const headers = { Origin: origin };
  if (cookies.has(actor)) headers.Cookie = cookies.get(actor);
  if (body) {
    headers["Content-Type"] = "application/json";
    if (operation)
      headers["Idempotency-Key"] = createHash("sha256")
        .update([fixture, actor, path, operation].join(":"))
        .digest("hex");
  }
  const response = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const answer = await response.json();
  if (!response.ok)
    throw new Error(path + " HTTP " + response.status + " " + answer.message);
  if (path === "/auth/login")
    cookies.set(actor, response.headers.get("Set-Cookie").split(";")[0]);
  return answer.result;
}

async function add(kind, code, name, data = {}, parentId = null) {
  const existing = await catalog.records.findOne({ kind, code, parentId });
  if (existing) return { id: String(existing._id), code };
  return send(admin, "/master/" + kind, {
    code,
    name,
    data,
    ...(parentId ? { parentId } : {}),
  });
}

async function publish(body) {
  const { type, modelId, lineId = null } = body;
  if (!(await catalog.versions.findOne({ type, modelId, lineId })))
    await send(admin, "/master/versions", body);
}

function imei(number) {
  const base = "00990182" + String(number).padStart(6, "0");
  const sum = [...base].reduce((total, digit, index) => {
    const value = Number(digit) * (index % 2 === 0 ? 1 : 2);
    return total + (value > 9 ? value - 9 : value);
  }, 0);
  return base + ((10 - (sum % 10)) % 10);
}

async function shipment({
  index,
  supplierId,
  warehouseId,
  skuId,
  shelfId,
  status,
}) {
  const number = String(8100 + index);
  const waybillNumber = "DEMO-1405-" + number;
  const existing = await stock.shipments.findOne({
    waybillNumber,
    warehouseId,
  });
  const row = existing
    ? { id: String(existing._id) }
    : await send(admin, "/shipments", {
        supplierId,
        warehouseId,
        waybillNumber,
        purchaseOrder: "PO-DEMO-" + number,
        expectedCartons: status === "discrepancy" ? 2 : 1,
      });
  const path = "/shipments/" + row.id;
  let detail = await send(admin, path);
  const pallet =
    detail.pallets[0] ??
    (await send(admin, path + "/pallets", { code: "PLT-1405-" + number }));
  const carton =
    detail.cartons[0] ??
    (await send(admin, path + "/cartons", {
      palletId: pallet.id,
      skuId,
      code: "CTN-1405-" + number,
      lot: "LOT-DEMO-" + number,
      quantity: "120",
      condition: status === "discrepancy" ? "quarantine" : "accepted",
    }));
  detail = await send(admin, path);
  if (detail.shipment.status === "receiving" && status !== "receiving") {
    await send(
      admin,
      path + "/receipts",
      {
        version: detail.shipment.version,
        ...(status === "discrepancy"
          ? { reason: "کسری یک کارتن و آسیب بسته‌بندی در حمل" }
          : {}),
      },
      number,
    );
  }
  if (status === "approved") {
    const balance = await stock.balances.findOne({ cartonId: carton.id });
    if (balance && balance.account === "receiving")
      await send(
        admin,
        "/inventory/cartons/" + carton.id + "/moves",
        {
          version: balance.version,
          locationId: shelfId,
        },
        number,
      );
  }
  return carton;
}

async function provideParts(modelId, warehouseId, lineId, carton, key) {
  const row = await send(
    admin,
    "/handover/requests",
    { modelId, warehouseId, lineId, count: 16 },
    key,
  );
  const path = "/handover/requests/" + row.id;
  const reserved = await send(
    admin,
    path + "/reservations",
    { version: 0, cartonCode: carton.code, quantity: "16" },
    key,
  );
  const issued = await send(
    admin,
    path + "/deliveries",
    { version: 1, reservationIds: [reserved.reservation.id] },
    key,
  );
  const item = (await send(admin, path)).custody.find(
    (line) => line.cartonId === carton.id,
  );
  await send(
    basketActor,
    "/handover/deliveries/" + issued.delivery.id + "/receipts",
    {
      version: 0,
      items: [{ itemId: item.id, quantity: "16" }],
    },
    key,
  );
  return item;
}

async function prepare(orderId, skuId, custodyId, key, state) {
  let basket = await send(basketActor, "/basket", { orderId }, key);
  const basketPath = "/basket/" + basket.id;
  const { unit } = await send(basketActor, basketPath);
  const act = (path, data = {}, actor = basketActor) =>
    send(actor, basketPath + path, { version: basket.version, ...data }, key);
  if (state === "draft") return unit;
  basket = (await act("/imei/print")).basket;
  basket = await act("/imei/scan", { code: unit.numbers[0] });
  const print = await act("/parts", { skuId, custodyId, quantity: "1" });
  basket = print.basket;
  basket = (await act("/parts/scan", { code: print.part.code, skuId })).basket;
  basket = await act("/ready");
  basket = await act("/handover");
  if (state !== "handed") await act("/receive", {}, assemblyActor);
  return { ...unit, partCode: print.part.code, partId: print.part.id };
}

async function assemble(unit, stations, modelId, testId, key, state) {
  for (const [index, station] of stations.entries()) {
    const { visit: initial } = await send(
      assemblyActor,
      "/assembly/entry",
      {
        stationId: station.id,
        modelId,
        code: unit.numbers[0],
      },
      key + ":" + index,
    );
    let visit = initial;
    const act = (path, data = {}, actor = assemblyActor) =>
      send(
        actor,
        "/assembly/visits/" + visit.id + "/" + path,
        { version: visit.version, ...data },
        key,
      );
    if (state === "active") return;
    if (!index) visit = (await act("install", { code: unit.partCode })).visit;
    visit = (
      await act("complete", {
        code: unit.numbers[0],
        checklist: index ? [] : [true],
      })
    ).visit;
    if (!index) {
      const failed = state === "defect";
      const tested = await act("test", {
        testId,
        answer: failed ? "NO" : "OK",
        outcome: failed ? "fail" : "pass",
      });
      visit = tested.visit;
      if (failed) {
        await send(
          admin,
          "/defects/visits/" + visit.id + "/declare",
          {
            testId,
            resultId: tested.result.id,
            partId: unit.partId,
            reason: "عدم روشن شدن دستگاه در آزمون نمونه",
          },
          key,
        );
        return;
      }
    }
    await act("transfer", {}, admin);
  }
}

async function pack(unit, key) {
  const path = "/final-qc/" + unit.id;
  const qc = await send(admin, path);
  const done = new Set(
    qc.results
      .filter(
        (result) =>
          result.round === qc.record?.round && result.outcome === "pass",
      )
      .map((result) => result.item),
  );
  if (!qc.record || qc.record.status === "testing") {
    for (const item of Object.keys(qc.checks)) {
      if (done.has(item)) continue;
      const current = await send(admin, path);
      await send(
        admin,
        path + "/check",
        { version: current.record?.version ?? 0, item, outcome: "pass" },
        key + ":" + item,
      );
    }
    const current = await send(admin, path);
    await send(
      admin,
      path + "/approve",
      { version: current.record.version, code: unit.numbers[0] },
      key,
    );
  }
  const current = await send(admin, path);
  if (current.record.status !== "packed") {
    const label = await send(
      admin,
      path + "/label",
      { version: current.record.version },
      key,
    );
    await send(
      admin,
      path + "/pack",
      {
        version: label.version,
        scans: unit.numbers,
        checklist: current.packing.map(() => true),
      },
      key,
    );
  }
}

try {
  for (const actor of [admin, basketActor, assemblyActor, defectsActor])
    await send(actor, "/auth/login", { username: actor, password });
  const branch = await add("branches", "DEMO-FACTORY", "کارخانه نمونه");
  const warehouse = await add(
    "warehouses",
    "DEMO-RAW",
    "انبار مواد اولیه",
    { purpose: "materials" },
    branch.id,
  );
  const output = await add(
    "warehouses",
    "DEMO-FIN",
    "انبار محصول نهایی",
    { purpose: "finished" },
    branch.id,
  );
  await add(
    "warehouses",
    "DEMO-DEF",
    "انبار معیوبی",
    { purpose: "defects" },
    branch.id,
  );
  await add(
    "warehouses",
    "DEMO-QUA",
    "قرنطینه",
    { purpose: "quarantine" },
    branch.id,
  );
  const shelf = await add(
    "locations",
    "A-01-01-1",
    "A-01-01-1",
    {},
    warehouse.id,
  );
  for (const code of [
    "A-01-01-2",
    "A-01-02-1",
    "A-01-02-2",
    "B-01-01-1",
    "B-01-01-2",
    "B-01-02-1",
    "B-01-02-2",
  ])
    await add("locations", code, code, {}, warehouse.id);
  const outputShelf = await add(
    "locations",
    "FG-01-01-1",
    "FG-01-01-1",
    {},
    output.id,
  );
  const pieces = await add("units", "DEMO-PCS", "عدد");
  const battery = await add("partTypes", "DBAT", "باتری", {
    unitId: pieces.id,
    minLineStock: 4,
  });
  const suppliers = await Promise.all([
    add("suppliers", "DEMO-SCD", "Sunwoda", { country: "چین" }),
    add("suppliers", "DEMO-BOE", "BOE", { country: "چین" }),
    add("suppliers", "DEMO-QT", "Q-Tech", { country: "چین" }),
  ]);
  const sku = await add("skus", "DEMO-BL4UL", "باتری BL-4UL", {
    partTypeId: battery.id,
    supplierId: suppliers[0].id,
    specification: "۱۲۰۰ میلی‌آمپرساعت",
  });
  const screen = await add("partTypes", "DLCD", "نمایشگر", {
    unitId: pieces.id,
  });
  const display = await add("skus", "DEMO-LCD24", "نمایشگر ۲٫۴ اینچ", {
    partTypeId: screen.id,
    supplierId: suppliers[1].id,
    specification: "۲۴۰×۳۲۰",
  });
  const black = await add("colors", "DEMO-BLK", "مشکی");
  const blue = await add("colors", "DEMO-BLU", "آبی");
  const model = await add("models", "DEMO-TA1576", "Nokia 130", {
    brand: "Nokia",
    colorIds: [black.id, blue.id],
    imeiSlots: 2,
  });
  await add("models", "DEMO-TA1564", "Nokia 106", {
    brand: "Nokia",
    colorIds: [black.id, blue.id],
    imeiSlots: 2,
  });
  const model3210 = await add("models", "DEMO-TA1619", "Nokia 3210", {
    brand: "Nokia",
    colorIds: [black.id, blue.id],
    imeiSlots: 2,
  });
  const test = await add("tests", "DEMO-POWER", "روشن شدن گوشی", {
    results: ["OK", "NO"],
  });
  const names = [
    "بدنه و فریم",
    "برد اصلی",
    "قطعات ارتباطی",
    "دوربین",
    "صدا و میکروفون",
    "باتری",
    "نمایشگر",
    "بستن و اتصالات نهایی",
  ];
  const lines = [];
  for (let i = 1; i <= 3; i++) {
    const line = await add(
      "lines",
      "DEMO-L" + i,
      "خط " + i.toLocaleString("fa-IR"),
      {},
      branch.id,
    );
    const stations = [];
    for (const [index, name] of names.entries()) {
      stations.push(
        await add(
          "stations",
          "ST-0" + (index + 1),
          name,
          {
            order: index + 1,
            operation: index === 0 ? "جاگذاری فریم و قاب" : name,
            maxRetests: 2,
            allowedRoleIds: ["assemblyOperator", "stOp0" + (index + 1)],
            ...(index === 0
              ? {
                  requirements: ["جای‌گیری قطعه و سلامت اتصال بررسی شد"],
                  testIds: [test.id],
                }
              : {}),
          },
          line.id,
        ),
      );
    }
    lines.push({ ...line, stations });
  }
  const identity = identityStore(database);
  for (const [index, station] of lines[0].stations.entries())
    await identity.users.updateOne(
      {
        username: "demo-st0" + (index + 1),
        demoAccount: true,
        scopes: { $size: 0 },
      },
      {
        $set: { scopes: [{ lineId: lines[0].id, stationId: station.id }] },
        $inc: { version: 1 },
      },
    );
  await publish({
    type: "bom",
    modelId: model.id,
    lines: [
      { skuId: sku.id, quantity: "1", stationCode: lines[0].stations[0].code },
    ],
  });
  for (const line of lines)
    await publish({
      type: "routing",
      modelId: model.id,
      lineId: line.id,
      stationIds: line.stations.map((station) => station.id),
    });
  const otherParts = [];
  for (const [typeCode, name, code, supplierIndex, specification] of [
    ["CAS", "بدنه و صفحه‌کلید", "DEMO-CASN3210", 1, "قاب مشکی Nokia 3210"],
    ["BRD", "برد اصلی", "DEMO-BRDT107", 2, "Unisoc T107 4G"],
    ["ANT", "آنتن", "DEMO-ANT4G", 2, "آنتن LTE 4G"],
    ["CAM", "دوربین", "DEMO-CAM2M", 2, "دوربین ۲ مگاپیکسل"],
    ["SPK", "اسپیکر", "DEMO-SPK1511", 0, "اسپیکر ۱ وات"],
    ["MIC", "میکروفون", "DEMO-MICECM", 0, "میکروفون ۴ میلی‌متری"],
  ]) {
    const type = await add("partTypes", typeCode, name, { unitId: pieces.id });
    otherParts.push(
      await add("skus", code, name, {
        partTypeId: type.id,
        supplierId: suppliers[supplierIndex].id,
        specification,
      }),
    );
  }
  const draftParts = [...otherParts, sku, display];
  const draftLine = lines[2];
  await publish({
    type: "bom",
    modelId: model3210.id,
    lines: draftParts.map((part, index) => ({
      skuId: part.id,
      quantity: "1",
      stationCode: draftLine.stations[Math.min(index, 6)].code,
    })),
  });
  await publish({
    type: "routing",
    modelId: model3210.id,
    lineId: draftLine.id,
    stationIds: draftLine.stations.map((station) => station.id),
  });
  const cartons = [];
  for (const [offset, status] of [
    "approved",
    "approved",
    "approved",
    "discrepancy",
    "receiving",
  ].entries())
    cartons.push(
      await shipment({
        index: offset + 1,
        status,
        supplierId: suppliers[0].id,
        warehouseId: warehouse.id,
        shelfId: shelf.id,
        skuId: sku.id,
      }),
    );
  await shipment({
    index: 6,
    status: "approved",
    supplierId: suppliers[1].id,
    warehouseId: warehouse.id,
    shelfId: shelf.id,
    skuId: display.id,
  });
  await send(
    admin,
    "/imei/imports",
    {
      modelId: model.id,
      source: fixture,
      rows: Array.from({ length: 48 }, (_, row) => ({
        row: row + 1,
        cells: [imei(row * 2 + 1), imei(row * 2 + 2)],
      })),
    },
    "pool",
  );
  const packedUnits = [];
  for (const [index, line] of lines.entries()) {
    const key = "line-" + index;
    const order = await send(
      admin,
      "/imei/orders",
      {
        modelId: model.id,
        colorId: index === 1 ? blue.id : black.id,
        lineId: line.id,
        count: 12,
      },
      key,
    );
    await send(admin, "/imei/orders/" + order.id + "/units", {}, key);
    const custody = await provideParts(
      model.id,
      warehouse.id,
      line.id,
      cartons[index],
      key,
    );
    const states =
      index === 0
        ? ["draft", "handed", "active", "defect", "quality", "packed"]
        : ["draft", "handed", "active"];
    for (const [sequence, state] of states.entries()) {
      const phase = key + ":" + sequence;
      const unit = await prepare(order.id, sku.id, custody.id, phase, state);
      if (state === "draft" || state === "handed") continue;
      await assemble(unit, line.stations, model.id, test.id, phase, state);
      if (state === "defect") {
        const part = await send(
          defectsActor,
          "/defects/receive",
          { code: unit.partCode },
          phase,
        );
        const returned = await send(
          defectsActor,
          "/defects/returns",
          { partIds: [part.id] },
          phase,
        );
        await send(
          defectsActor,
          "/defects/returns/" + returned.id + "/advance",
          {
            version: returned.version,
            status: "dispatched",
            reference: "RT-DEMO-1405",
          },
          phase,
        );
      }
      if (state === "packed") {
        await pack(unit, phase);
        packedUnits.push(unit);
      }
    }
    if (index === 0) {
      const batch = await send(
        admin,
        "/imei/orders",
        {
          modelId: model.id,
          colorId: black.id,
          lineId: line.id,
          count: 9,
        },
        "stock-batch",
      );
      await send(
        admin,
        "/imei/orders/" + batch.id + "/units",
        {},
        "stock-batch",
      );
      for (let i = 0; i < 8; i++) {
        const phase = "stock-batch-" + i;
        const unit = await prepare(
          batch.id,
          sku.id,
          custody.id,
          phase,
          "packed",
        );
        await assemble(unit, line.stations, model.id, test.id, phase, "packed");
        await pack(unit, phase);
        packedUnits.push(unit);
      }
    }
  }
  await send(
    admin,
    "/handover/requests",
    {
      modelId: model3210.id,
      lineId: draftLine.id,
      warehouseId: warehouse.id,
      count: 12,
    },
    "draft-nokia-3210",
  );
  const outputPath = "/finished/cartons";
  const carton = await send(
    admin,
    outputPath,
    { warehouseId: output.id, modelId: model.id, colorId: black.id },
    "finished",
  );
  let stored = await send(
    admin,
    outputPath,
    { warehouseId: output.id, modelId: model.id, colorId: black.id },
    "stored",
  );
  const cartonPath = outputPath + "/" + stored.id;
  for (const [index, unit] of packedUnits.entries()) {
    stored = await send(
      admin,
      cartonPath + "/scan",
      {
        version: stored.version,
        code: unit.numbers[0],
      },
      "stock-box-" + index,
    );
  }
  stored = await send(
    admin,
    cartonPath + "/label",
    { version: stored.version },
    "stock-label",
  );
  stored = await send(
    admin,
    cartonPath + "/close",
    { version: stored.version, code: stored.code },
    "stock-close",
  );
  stored = await send(
    admin,
    cartonPath + "/place",
    {
      version: stored.version,
      locationId: outputShelf.id,
      code: outputShelf.code,
    },
    "stock-place",
  );
  console.log(
    "Demo data ready. Open carton: " +
      carton.code +
      ". Placed carton: " +
      stored.code +
      ". Material carton: " +
      cartons[0].code +
      ".",
  );
} finally {
  for (const actor of cookies.keys())
    await send(actor, "/auth/logout", {}).catch(() => {});
  await database.close();
}
