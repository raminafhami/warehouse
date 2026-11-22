import { Decimal128, ObjectId } from "mongodb";
import { ApiError } from "../http-error.js";
import { activeReference } from "../catalog/records.js";
import { idText, integer, quantity } from "../catalog/validation.js";
import { fields, text } from "../identity/validation.js";

/** @typedef {ReturnType<typeof import("./store.js").shipmentStore>} Store */
/** @typedef {ReturnType<typeof import("../catalog/store.js").catalogStore>} Catalog */
/** @typedef {import("./store.js").Shipment} Shipment */
/** @typedef {import("./store.js").Carton} Carton */
/** @typedef {import("mongodb").ClientSession} Session */
/** @typedef {import("../identity/permissions.js").Scope} Scope */

export const absent = () =>
  new ApiError(404, "SHIPMENT_NOT_FOUND", "محموله یا رکورد وابسته پیدا نشد.");
/** @param {string} message */
export const violation = (message) =>
  new ApiError(400, "INVALID_SHIPMENT", message);
/** @param {string} message */
export const conflict = (message) =>
  new ApiError(409, "SHIPMENT_CONFLICT", message);

/** @param {unknown} value @param {"PLT" | "CTN"} prefix */
function barcode(value, prefix) {
  const code = text(value, 35)
    .toUpperCase()
    .replace(/[۰-۹]/gu, (digit) => String(digit.charCodeAt(0) - 1776))
    .replace(/[٠-٩]/gu, (digit) => String(digit.charCodeAt(0) - 1632));
  if (!new RegExp("^" + prefix + "-[0-9]{4}-[0-9]{1,15}$").test(code)) {
    throw violation(`فرمت بارکد معتبر نیست، مانند ${prefix}-1405-00001.`);
  }
  return code;
}

/** @param {Shipment} shipment */
export function assertOpen(shipment) {
  if (shipment.status === "approved")
    throw conflict("این محموله نهایی شده است.");
}

/**
 * @param {Store} store @param {Catalog} catalog @param {unknown} input @param {string} actorId
 * @param {Session} session @param {(scope: Scope) => void} authorize
 */
export async function createShipment(
  store,
  catalog,
  input,
  actorId,
  session,
  authorize,
) {
  const body = fields(input);
  const warehouseId = idText(body.warehouseId);
  const supplierId = idText(body.supplierId);
  const warehouse = await activeReference(
    catalog,
    "warehouses",
    warehouseId,
    session,
  );
  authorize(warehouse.scope);
  const supplier = await activeReference(
    catalog,
    "suppliers",
    supplierId,
    session,
  );
  const waybillNumber = text(body.waybillNumber, 80);
  const expectedCartons = integer(body.expectedCartons, 1, 10000);
  const counter = await store.counters.findOneAndUpdate(
    { _id: "shipment" },
    { $inc: { value: 1 } },
    { returnDocument: "after", session },
  );
  if (!counter) throw new Error("Shipment sequence not initialized.");
  /** @type {Shipment} */
  const record = {
    _id: new ObjectId(),
    sequence: counter.value,
    code: "SHP-" + String(counter.value).padStart(6, "0"),
    supplierId,
    supplierName: supplier.name,
    warehouseId,
    warehouseName: warehouse.name,
    scope: warehouse.scope,
    waybillNumber,
    purchaseOrder: text(body.purchaseOrder, 80, true),
    expectedCartons,
    scannedCartons: 0,
    receivedCartons: 0,
    quarantinedCartons: 0,
    palletCount: 0,
    status: "receiving",
    notes: text(body.notes, 500, true),
    createdAt: new Date(),
    createdBy: actorId,
    version: 0,
  };
  await store.shipments.insertOne(record, { session });
  return record;
}

/**
 * @param {Store} store @param {Shipment} shipment @param {Session} session
 * @param {import("mongodb").UpdateFilter<Shipment>} update
 */
export async function touchShipment(store, shipment, session, update) {
  const result = await store.shipments.findOneAndUpdate(
    { _id: shipment._id, version: shipment.version },
    {
      ...update,
      $inc: { ...update.$inc, version: 1 },
    },
    { returnDocument: "after", session },
  );
  if (!result) throw conflict("محموله تغییر کرده است. دوباره تلاش کنید.");
  return result;
}

/** @param {Store} store @param {Shipment} shipment @param {unknown} input @param {Session} session */
export async function scanPallet(store, shipment, input, session) {
  assertOpen(shipment);
  const code = barcode(fields(input).code, "PLT");
  if (await store.pallets.findOne({ code }, { session }))
    throw conflict("این بارکد پالت قبلاً ثبت شده است.");
  const pallet = {
    _id: new ObjectId(),
    shipmentId: String(shipment._id),
    code,
    at: new Date(),
  };
  await touchShipment(store, shipment, session, { $inc: { palletCount: 1 } });
  await store.pallets.insertOne(pallet, { session });
  return pallet;
}

/** @param {Store} store @param {Catalog} catalog @param {Shipment} shipment @param {unknown} input @param {Session} session */
export async function scanCarton(store, catalog, shipment, input, session) {
  assertOpen(shipment);
  const body = fields(input);
  const shipmentId = String(shipment._id);
  const pallet = await store.pallets.findOne(
    { _id: new ObjectId(idText(body.palletId)), shipmentId },
    { session },
  );
  if (!pallet) throw violation("پالت به این محموله تعلق ندارد.");
  const code = barcode(body.code, "CTN");
  const existing = await store.cartons.findOne({ code }, { session });
  if (
    existing &&
    (existing.shipmentId !== shipmentId || existing.state !== "removed")
  ) {
    throw conflict("این بارکد کارتن قبلاً ثبت شده است.");
  }
  const sku = await activeReference(
    catalog,
    "skus",
    idText(body.skuId),
    session,
  );
  if (sku.data.supplierId !== shipment.supplierId)
    throw violation("کد کالا متعلق به تأمین‌کنندهٔ این محموله نیست.");
  const type = await activeReference(
    catalog,
    "partTypes",
    String(sku.data.partTypeId),
    session,
  );
  const unit = await activeReference(
    catalog,
    "units",
    String(type.data.unitId),
    session,
  );
  const scale = Number(unit.data.scale);
  if (quantity(body.quantity, scale) % quantity(unit.data.step, scale) !== 0n) {
    throw violation("مقدار کارتن با گام واحد شمارش سازگار نیست.");
  }
  const condition = body.condition ?? "accepted";
  if (condition !== "accepted" && condition !== "quarantine")
    throw violation("وضعیت کارتن معتبر نیست.");
  /** @type {Carton} */
  const carton = {
    _id: existing?._id ?? new ObjectId(),
    shipmentId,
    palletId: String(pallet._id),
    code,
    skuId: String(sku._id),
    skuCode: sku.code,
    lot: text(body.lot, 80, true),
    quantity: Decimal128.fromString(String(body.quantity)),
    state: "scanned",
    condition,
    at: new Date(),
  };
  await touchShipment(store, shipment, session, {
    $inc: { scannedCartons: 1 },
  });
  if (existing)
    await store.cartons.replaceOne(
      { _id: carton._id, state: "removed" },
      carton,
      { session },
    );
  else await store.cartons.insertOne(carton, { session });
  return carton;
}

/** @param {Store} store @param {Shipment} shipment @param {ObjectId} id @param {Session} session */
export async function removeCarton(store, shipment, id, session) {
  const carton = await store.cartons.findOne(
    { _id: id, shipmentId: String(shipment._id) },
    { session },
  );
  if (!carton || carton.state === "removed") throw absent();
  if (carton.state === "received")
    throw conflict("کارتن دریافت‌شده قابل حذف نیست. مغایرت را ثبت کنید.");
  assertOpen(shipment);
  await touchShipment(store, shipment, session, {
    $inc: { scannedCartons: -1 },
  });
  await store.cartons.updateOne(
    { _id: id, state: "scanned" },
    { $set: { state: "removed" } },
    { session },
  );
  return carton;
}
