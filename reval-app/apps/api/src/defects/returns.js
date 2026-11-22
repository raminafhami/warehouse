import { ObjectId } from "mongodb";
import { conflict, missing } from "../assembly/workflow.js";
import { scanCode } from "../basket/workflow.js";
import { publicPart } from "../basket/parts.js";
import { nextCode } from "../handover/requests.js";
import { requirePermission } from "../identity/permissions.js";
import {
  badInput,
  objectId,
  text,
  versionInput,
} from "../identity/validation.js";
import { move } from "./movement.js";

/** @typedef {import("../assembly/store.js").Store} Store */
/** @typedef {import("./store.js").ReturnDocument} ReturnDocument */
/** @typedef {import("../basket/store.js").Part} Part */
/** @typedef {import("../identity/commands.js").Actor} Actor */
/** @typedef {import("mongodb").ClientSession} Session */
/** @typedef {Record<string,unknown>} Body */

/** @param {Part} part */
export const returnScope = (part) => ({
  ...part.scope,
  warehouseId: part.warehouseId,
});

/** @param {Store} store @param {Actor} actor @param {Body} body @param {Session} session */
export async function receive(store, actor, body, session) {
  const part = await store.parts.findOne(
    {
      code: scanCode(text(body.code, 80)),
      state: { $in: ["defective", "defect_store", "supplier_return"] },
    },
    { session },
  );
  if (!part) throw missing();
  requirePermission(actor.grant, "defects:scan", returnScope(part));
  if (part.state !== "defective")
    throw conflict("دریافت این قطعه قبلاً ثبت شده است.");
  const actorId = String(actor.user._id);
  await move(
    store,
    part,
    "defective",
    "defect_store",
    actorId,
    part.defectId ?? String(part._id),
    session,
  );
  const received = await store.parts.findOneAndUpdate(
    { _id: part._id, state: "defective" },
    {
      $set: {
        state: "defect_store",
        defectReceivedAt: new Date(),
        defectReceivedBy: actorId,
      },
    },
    { session, returnDocument: "after" },
  );
  if (!received) throw conflict("قطعه قبلاً دریافت شده است.");
  return received;
}

/** @param {Store} store @param {Actor} actor @param {Body} body @param {Session} session */
export async function createReturn(store, actor, body, session) {
  if (
    !Array.isArray(body.partIds) ||
    !body.partIds.length ||
    body.partIds.length > 100
  )
    throw badInput();
  const ids = body.partIds.map(objectId);
  if (new Set(ids.map(String)).size !== ids.length) throw badInput();
  const parts = await store.parts
    .find({ _id: { $in: ids } }, { session })
    .toArray();
  if (parts.length !== ids.length) throw missing();
  const head = parts[0];
  for (const part of parts) {
    requirePermission(actor.grant, "defects:create", returnScope(part));
    if (part.state !== "defect_store" || part.returnId)
      throw conflict("قطعه باید در قرنطینه و بدون سند مرجوعی باشد.");
    if (
      part.warehouseId !== head.warehouseId ||
      part.lineId !== head.lineId ||
      part.scope.stationId !== head.scope.stationId
    )
      throw conflict("اقلام سند باید از یک انبار و یک ایستگاه باشند.");
  }
  const cartons = await store.cartons
    .find(
      { _id: { $in: parts.map((part) => objectId(part.cartonId)) } },
      { session },
    )
    .toArray();
  const shipments = await store.shipments
    .find(
      { _id: { $in: cartons.map((carton) => objectId(carton.shipmentId)) } },
      { session },
    )
    .toArray();
  const shipment = shipments[0];
  if (
    !shipment ||
    cartons.length !== new Set(parts.map((part) => part.cartonId)).size ||
    shipments.length !==
      new Set(cartons.map((carton) => carton.shipmentId)).size ||
    shipments.some((row) => row.supplierId !== shipment.supplierId)
  )
    throw conflict("همهٔ قطعات سند باید از یک تأمین‌کننده باشند.");
  const at = new Date();
  /** @type {ReturnDocument} */
  const row = {
    _id: new ObjectId(),
    code: await nextCode(store, "supplier-return", "RET", session),
    scope: returnScope(head),
    supplierId: shipment.supplierId,
    supplierName: shipment.supplierName,
    parts: parts.map((part) => ({
      id: String(part._id),
      code: part.code,
      skuCode: part.skuCode,
      quantity: publicPart(part).quantity,
    })),
    status: "prepared",
    version: 1,
    at,
    events: [{ action: "prepared", at, actorId: String(actor.user._id) }],
  };
  await store.parts.updateMany(
    { _id: { $in: ids } },
    { $set: { returnId: String(row._id) } },
    { session },
  );
  await store.returns.insertOne(row, { session });
  return row;
}

/** @param {Store} store @param {unknown} id @param {Session} [session] */
export async function loadReturn(store, id, session) {
  const row = await store.returns.findOne({ _id: objectId(id) }, { session });
  if (!row) throw missing();
  return row;
}

/** @param {Store} store @param {ReturnDocument} row @param {Actor} actor @param {Body} body @param {Session} session */
export async function advanceReturn(store, row, actor, body, session) {
  requirePermission(actor.grant, "defects:transfer", row.scope);
  if (versionInput(body.version) !== row.version || row.status === "delivered")
    throw conflict("سند تغییر کرده یا بسته شده است.");
  const status = row.status === "prepared" ? "dispatched" : "delivered";
  if (body.status !== status) throw conflict("ترتیب گردش سند معتبر نیست.");
  const reference = text(body.reference, 160);
  const actorId = String(actor.user._id);
  if (status === "delivered") {
    const parts = await store.parts
      .find({ returnId: String(row._id), state: "defect_store" }, { session })
      .toArray();
    if (parts.length !== row.parts.length)
      throw conflict("اقلام سند با موجودی قرنطینه منطبق نیستند.");
    for (const part of parts) {
      await move(
        store,
        part,
        "defect_store",
        "supplier_return",
        actorId,
        String(row._id),
        session,
      );
      await store.parts.updateOne(
        { _id: part._id },
        { $set: { state: "supplier_return" } },
        { session },
      );
    }
  }
  const next = await store.returns.findOneAndUpdate(
    { _id: row._id, version: row.version },
    {
      $set: { status },
      $inc: { version: 1 },
      $push: { events: { action: status, actorId, at: new Date(), reference } },
    },
    { session, returnDocument: "after" },
  );
  if (!next) throw conflict("سند تغییر کرده است.");
  return next;
}
