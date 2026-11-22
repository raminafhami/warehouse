import { ObjectId } from "mongodb";
import { ApiError } from "../http-error.js";
import { catalogStore } from "../catalog/store.js";
import { activeReference } from "../catalog/records.js";
import { idText, integer } from "../catalog/validation.js";
import {
  fields,
  objectId,
  text,
  versionInput,
} from "../identity/validation.js";
import { amountText, commandAmount, minor } from "../inventory/amounts.js";
import {
  loadBalance,
  publicReservation,
  release,
  reserve,
  unitFor,
} from "../inventory/commands.js";
import { publicRequest } from "./store.js";

/** @typedef {ReturnType<typeof import("./store.js").handoverStore>} Store */
/** @typedef {import("./store.js").MaterialRequest} MaterialRequest */
/** @typedef {import("mongodb").ClientSession} Session */
/** @typedef {import("../identity/permissions.js").Scope} Scope */
export const missing = () =>
  new ApiError(404, "HANDOVER_NOT_FOUND", "درخواست، حواله یا کارتن پیدا نشد.");
/** @param {string} message */
export const invalid = (message) =>
  new ApiError(400, "INVALID_HANDOVER", message);
/** @param {string} message */
export const conflict = (message) =>
  new ApiError(409, "HANDOVER_CONFLICT", message);

/** @param {Store} store @param {ObjectId} id @param {Session} [session] */
export async function loadRequest(store, id, session) {
  const row = await store.requests.findOne({ _id: id }, { session });
  if (!row) throw missing();
  return row;
}
/** @param {Store} store @param {string} name @param {string} prefix @param {Session} session */
export async function nextCode(store, name, prefix, session) {
  const counter = await store.counters.findOneAndUpdate(
    { _id: name },
    { $inc: { value: 1 } },
    { session, returnDocument: "after" },
  );
  if (!counter) throw new Error("Handover number sequence is unavailable.");
  return prefix + "-" + String(counter.value).padStart(6, "0");
}
/** @param {MaterialRequest} row @param {unknown} version */
export function openVersion(row, version) {
  if (row.version !== versionInput(version))
    throw conflict("نسخهٔ درخواست تغییر کرده است. دوباره بارگیری کنید.");
  if (row.status !== "open" && row.status !== "partial")
    throw conflict("درخواست برای تغییر باز نیست.");
}
/** @param {Store} store @param {MaterialRequest} row @param {Partial<MaterialRequest>} update @param {Session} session */
export async function updateRequest(store, row, update, session) {
  const after = await store.requests.findOneAndUpdate(
    { _id: row._id, version: row.version },
    {
      $set: update,
      $inc: { version: 1 },
    },
    { session, returnDocument: "after" },
  );
  if (!after) throw conflict("نسخهٔ درخواست تغییر کرده است.");
  return after;
}
/** @param {Store} store @param {unknown} input @param {string} actorId @param {Session} session @param {(warehouse:Scope,line:Scope)=>void} authorize */
export async function createRequest(store, input, actorId, session, authorize) {
  const body = fields(input);
  const count = integer(body.count, 1, 1000000);
  const modelId = idText(body.modelId);
  const warehouseId = idText(body.warehouseId);
  const lineId = idText(body.lineId);
  const catalog = catalogStore(store.database);
  const warehouse = await activeReference(
    catalog,
    "warehouses",
    warehouseId,
    session,
  );
  const line = await activeReference(catalog, "lines", lineId, session);
  authorize(warehouse.scope, line.scope);
  const model = await activeReference(catalog, "models", modelId, session);
  const bom = await catalog.versions.findOne(
    { type: "bom", modelId, lineId: null },
    { sort: { revision: -1 }, session },
  );
  if (!bom?.lines?.length) throw invalid("مدل انتخابی BOM منتشرشده ندارد.");
  const needs = bom.lines.map((item) => ({
    skuId: item.skuId,
    skuCode: item.skuCode,
    required: amountText(minor(item.quantity) * BigInt(count)),
    issued: "0",
  }));
  /** @type {MaterialRequest} */
  const row = {
    _id: new ObjectId(),
    code: await nextCode(store, "material-request", "REQ", session),
    modelId,
    modelName: model.name,
    bomVersionId: String(bom._id),
    bomRevision: bom.revision,
    count,
    warehouseId,
    warehouseName: warehouse.name,
    warehouseScope: warehouse.scope,
    lineId,
    lineName: line.name,
    lineScope: line.scope,
    ...(warehouse.scope.branchId === line.scope.branchId
      ? { combinedScope: { ...warehouse.scope, ...line.scope } }
      : {}),
    needs,
    status: "open",
    version: 0,
    actorId,
    at: new Date(),
  };
  await store.requests.insertOne(row, { session });
  return publicRequest(row);
}
/** @param {Store} store @param {MaterialRequest} row @param {unknown} input @param {string} actorId @param {Session} session */
export async function reserveCarton(store, row, input, actorId, session) {
  const body = fields(input);
  openVersion(row, body.version);
  const code = text(body.cartonCode, 35)
    .toUpperCase()
    .replace(/[۰-۹]/gu, (d) => String(d.charCodeAt(0) - 1776))
    .replace(/[٠-٩]/gu, (d) => String(d.charCodeAt(0) - 1632));
  const carton = await store.cartons.findOne(
    { code, state: "received" },
    { session },
  );
  if (!carton) throw missing();
  const balance = await loadBalance(store, String(carton._id), session);
  if (balance.warehouseId !== row.warehouseId || balance.account !== "storage")
    throw invalid("کارتن در موجودی قابل تحویل انبار این درخواست نیست.");
  const need = row.needs.find((need) => need.skuId === balance.skuId);
  if (!need) throw invalid("کد کالا در BOM این درخواست نیست.");
  const catalog = catalogStore(store.database);
  const amount = commandAmount(
    body.quantity,
    await unitFor(catalog, balance, session),
  );
  const requestId = String(row._id);
  if (
    await store.reservations.findOne(
      { requestId, cartonId: balance.cartonId, state: "active" },
      { session },
    )
  ) {
    throw conflict("این کارتن قبلاً برای همین درخواست رزرو شده است.");
  }
  const existing = await store.reservations
    .find({ requestId, skuId: need.skuId, state: "active" }, { session })
    .toArray();
  const reserved = existing.reduce(
    (sum, item) => sum + minor(item.quantity.toString()),
    0n,
  );
  if (minor(need.issued) + reserved + amount > minor(need.required))
    throw conflict("مقدار رزرو از نیاز باقی‌ماندهٔ درخواست بیشتر است.");
  await updateRequest(store, row, {}, session);
  const result = await reserve(
    store,
    catalog,
    balance,
    { version: balance.version, quantity: body.quantity },
    actorId,
    session,
    requestId,
  );
  return { reservation: result.reservation, cartonCode: code };
}
/** @param {Store} store @param {MaterialRequest} row @param {ObjectId} reservationId @param {unknown} input @param {string} actorId @param {Session} session */
export async function releaseCarton(
  store,
  row,
  reservationId,
  input,
  actorId,
  session,
) {
  openVersion(row, fields(input).version);
  const reservation = await store.reservations.findOne(
    { _id: reservationId, requestId: String(row._id), state: "active" },
    { session },
  );
  if (!reservation) throw missing();
  const balance = await loadBalance(store, reservation.cartonId, session);
  await updateRequest(store, row, {}, session);
  const result = await release(
    store,
    balance,
    reservationId,
    { version: balance.version },
    actorId,
    session,
    String(row._id),
  );
  return result.reservation;
}
/** @param {Store} store @param {MaterialRequest} row @param {unknown} input @param {string} actorId @param {Session} session */
export async function cancelRequest(store, row, input, actorId, session) {
  const body = fields(input);
  openVersion(row, body.version);
  const reason = text(body.reason, 500);
  const updated = await updateRequest(
    store,
    row,
    { status: "cancelled", cancellationReason: reason },
    session,
  );
  const pending = await store.reservations
    .find({ requestId: String(row._id), state: "active" }, { session })
    .toArray();
  for (const item of pending) {
    const balance = await loadBalance(store, item.cartonId, session);
    await release(
      store,
      balance,
      item._id,
      { version: balance.version },
      actorId,
      session,
      String(row._id),
    );
  }
  return publicRequest(updated);
}
/** @param {Store} store @param {MaterialRequest} row */
export async function activeRequestReservations(store, row) {
  const reservations = await store.reservations
    .find({ requestId: String(row._id), state: "active" })
    .sort({ at: 1 })
    .toArray();
  const ids = reservations.map((item) => objectId(item.cartonId));
  const cartons = await store.cartons.find({ _id: { $in: ids } }).toArray();
  const codes = new Map(cartons.map((item) => [String(item._id), item.code]));
  return reservations.map((item) => ({
    ...publicReservation(item),
    cartonCode: codes.get(item.cartonId) ?? item.cartonId,
  }));
}
