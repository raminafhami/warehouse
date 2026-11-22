import { finishedCollections } from "../finished/store.js";
import { basketStore } from "../basket/store.js";
import { ObjectId } from "mongodb";
import { catalogStore } from "../catalog/store.js";
import { activeReference } from "../catalog/records.js";
import { idText, integer } from "../catalog/validation.js";
import { ApiError } from "../http-error.js";
import { fields, text, versionInput } from "../identity/validation.js";
import { publicRow } from "./store.js";

/** @typedef {import("./store.js").Store} Store */
/** @typedef {import("./store.js").Order} Order */
/** @typedef {import("./store.js").Unit} Unit */
/** @typedef {import("./store.js").Scope} Scope */
/** @typedef {import("mongodb").ClientSession} Session */

export const missing = () =>
  new ApiError(404, "IMEI_NOT_FOUND", "رکورد پیدا نشد.");
/** @param {string} message */
export const conflict = (message) =>
  new ApiError(409, "IMEI_CONFLICT", message);

/** @param {Store} store @param {string} name @param {string} prefix @param {Session} session */
async function code(store, name, prefix, session) {
  const counter = await store.counters.findOneAndUpdate(
    { _id: name },
    { $inc: { value: 1 } },
    { session, returnDocument: "after" },
  );
  if (!counter) throw new Error("Production code sequence is unavailable.");
  return prefix + "-" + String(counter.value).padStart(6, "0");
}

/** @param {Store} store @param {string} entityId @param {string} action @param {string} actorId @param {Scope} scope @param {object} detail @param {Session} session */
export async function history(
  store,
  entityId,
  action,
  actorId,
  scope,
  detail,
  session,
) {
  await store.history.insertOne(
    {
      _id: new ObjectId(),
      entityId,
      action,
      actorId,
      scope,
      detail,
      at: new Date(),
    },
    { session },
  );
}

/** @param {Store} store @param {unknown} input @param {(scope:Scope)=>void} authorize @param {Session} session */
export async function createOrder(store, input, authorize, session) {
  const body = fields(input);
  const modelId = idText(body.modelId);
  const colorId = idText(body.colorId);
  const lineId = idText(body.lineId);
  const count = integer(body.count, 1, 1000000);
  const catalog = catalogStore(store.database);
  const line = await activeReference(catalog, "lines", lineId, session);
  authorize(line.scope);
  const model = await activeReference(catalog, "models", modelId, session);
  const color = await activeReference(catalog, "colors", colorId, session);
  const colorIds = /** @type {string[]} */ (model.data.colorIds);
  if (!colorIds.includes(colorId))
    throw conflict("رنگ برای این مدل تعریف نشده است.");
  const bom = await catalog.versions.findOne(
    { type: "bom", modelId, lineId: null },
    { session, sort: { revision: -1 } },
  );
  const routing = await catalog.versions.findOne(
    { type: "routing", modelId, lineId },
    { session, sort: { revision: -1 } },
  );
  if (!bom || !routing)
    throw conflict("برای این مدل و خط، BOM و مسیر تولید منتشرشده لازم است.");
  const row = {
    _id: new ObjectId(),
    code: await code(store, "production-order", "PO", session),
    modelId,
    modelName: model.name,
    colorId,
    colorName: color.name,
    lineId,
    lineName: line.name,
    scope: line.scope,
    imeiSlots: Number(model.data.imeiSlots),
    bomVersionId: String(bom._id),
    bomRevision: bom.revision,
    routingVersionId: String(routing._id),
    routingRevision: routing.revision,
    count,
    allocated: 0,
    replacementDue: 0,
    version: 0,
    at: new Date(),
  };
  await store.orders.insertOne(row, { session });
  return publicRow(row);
}

/** @param {Store} store @param {Order} order @param {string} actorId @param {Session} session @param {Unit} [replacing] */
export async function allocateUnit(store, order, actorId, session, replacing) {
  if (
    replacing &&
    (replacing.orderId !== String(order._id) || replacing.state !== "void")
  )
    throw conflict(
      "فقط برای گوشی دارای IMEI ابطال‌شده می‌توان شناسهٔ جایگزین تخصیص داد.",
    );
  if (!replacing && order.allocated + order.replacementDue >= order.count)
    throw conflict("ظرفیت دستور تولید پر شده است.");
  if (replacing && order.replacementDue < 1)
    throw conflict("جایگزینی در دستور ثبت نشده است.");
  const id = replacing?._id ?? new ObjectId();
  const pair = await store.pairs.findOneAndUpdate(
    {
      modelId: order.modelId,
      status: "free",
      numbers: { $size: order.imeiSlots },
    },
    { $set: { status: "allocated", unitId: String(id), scope: order.scope } },
    { session, sort: { _id: 1 }, returnDocument: "after" },
  );
  if (!pair)
    throw conflict(
      "برای مدل و تعداد سیم‌کارت این دستور، IMEI آزاد وجود ندارد.",
    );
  const orderUpdate = await store.orders.updateOne(
    { _id: order._id, version: order.version },
    {
      $inc: {
        allocated: 1,
        version: 1,
        ...(replacing ? { replacementDue: -1 } : {}),
      },
    },
    { session },
  );
  if (!orderUpdate.modifiedCount)
    throw conflict("ظرفیت دستور تولید تغییر کرده است.");
  /** @type {Unit} */
  const row = {
    _id: id,
    code: replacing?.code ?? (await code(store, "phone-unit", "PH", session)),
    orderId: String(order._id),
    orderCode: order.code,
    ...(replacing?.basketId ? { basketId: replacing.basketId } : {}),
    modelId: order.modelId,
    modelName: order.modelName,
    scope: order.scope,
    lineName: order.lineName,
    pairId: String(pair._id),
    numbers: pair.numbers,
    state: "allocated",
    version: replacing ? replacing.version + 1 : 0,
    at: replacing?.at ?? new Date(),
  };
  if (replacing)
    await store.units.replaceOne({ _id: id, version: replacing.version }, row, {
      session,
    });
  else await store.units.insertOne(row, { session });
  const action = replacing ? "unit.replace" : "unit.allocate";
  await history(
    store,
    String(id),
    action,
    actorId,
    order.scope,
    { pairId: row.pairId, orderId: row.orderId, numbers: row.numbers },
    session,
  );
  return publicRow(row);
}

/** @param {Store} store @param {Unit} unit @param {unknown} input @param {"released"|"void"} state @param {string} actorId @param {Session} session */
export async function retirePair(store, unit, input, state, actorId, session) {
  const body = fields(input);
  const reason = text(body.reason, 500);
  checkUnitVersion(unit, body.version);
  if (
    await finishedCollections(store.database).final.findOne(
      { _id: unit._id },
      { session },
    )
  )
    throw conflict(
      "پس از شروع کنترل کیفیت نهایی، اصلاح IMEI به گردش بازبینی محصول نیاز دارد.",
    );
  if (unit.hamtaStatus && unit.hamtaStatus !== "pending")
    throw conflict("با شروع فرایند همتا، تغییر IMEI در این مسیر مجاز نیست.");
  if (Boolean(unit.printedAt) !== (state === "void"))
    throw conflict(
      state === "void"
        ? "ابطال برای شناسهٔ چاپ‌شده است."
        : "شناسهٔ چاپ‌شده باید با مجوز کنترل کیفیت ابطال شود.",
    );
  if (state === "released" && unit.basketId) {
    const baskets = basketStore(store.database).baskets;
    const cancelled = await baskets.updateOne(
      { _id: new ObjectId(unit.basketId), status: "preparing" },
      { $set: { status: "cancelled" }, $inc: { version: 1 } },
      { session },
    );
    if (!cancelled.modifiedCount)
      throw conflict("وضعیت سبد اجازهٔ آزادسازی IMEI را نمی‌دهد.");
  }
  const pairId = new ObjectId(unit.pairId);
  const pair = await store.pairs.updateOne(
    { _id: pairId, unitId: String(unit._id), status: "allocated" },
    state === "void"
      ? { $set: { status: "void" }, $unset: { hamtaStatus: "" } }
      : {
          $set: { status: "free" },
          $unset: { unitId: "", scope: "", hasError: "" },
        },
    { session },
  );
  const order = await store.orders.updateOne(
    { _id: new ObjectId(unit.orderId), allocated: { $gt: 0 } },
    {
      $inc: {
        allocated: -1,
        version: 1,
        ...(state === "void" ? { replacementDue: 1 } : {}),
      },
    },
    { session },
  );
  if (!pair.modifiedCount || !order.modifiedCount)
    throw conflict("ماندهٔ تخصیص با دستور تولید سازگار نیست.");
  const row = await store.units.findOneAndUpdate(
    { _id: unit._id, version: unit.version },
    {
      $set: { state },
      $unset: { qcPassedAt: "", hamtaStatus: "" },
      $inc: { version: 1 },
    },
    { session, returnDocument: "after" },
  );
  if (!row) throw conflict("نسخهٔ گوشی تغییر کرده است.");
  await history(
    store,
    String(unit._id),
    "unit." + state,
    actorId,
    unit.scope,
    { pairId: unit.pairId, reason, numbers: unit.numbers },
    session,
  );
  return publicRow(row);
}

/** @param {Unit} unit @param {unknown} version */
export function checkUnitVersion(unit, version) {
  if (unit.version !== versionInput(version) || unit.state !== "allocated")
    throw conflict("نسخه یا وضعیت تخصیص گوشی تغییر کرده است.");
}

/**
 * Called by the label and final-QC workflows in their own transaction after
 * checking their domain permissions and completing the corresponding operation.
 * @param {Store} store @param {Unit} unit @param {"printed"|"final-qc"} milestone @param {string} actorId @param {Session} session
 */
export async function recordMilestone(
  store,
  unit,
  milestone,
  actorId,
  session,
) {
  if (
    unit.state !== "allocated" ||
    unit.hamtaStatus ||
    unit.imeiError ||
    (milestone === "final-qc" && !unit.printedAt)
  )
    throw conflict("وضعیت گوشی با این مرحله سازگار نیست.");
  const at = new Date();
  const data =
    milestone === "printed"
      ? { printedAt: at }
      : { qcPassedAt: at, hamtaStatus: /** @type {const} */ ("pending") };
  if (milestone === "printed" && unit.printedAt) return publicRow(unit);
  const row = await store.units.findOneAndUpdate(
    { _id: unit._id, version: unit.version },
    { $set: data, $inc: { version: 1 } },
    { session, returnDocument: "after" },
  );
  if (!row) throw conflict("نسخهٔ گوشی تغییر کرده است.");
  if (milestone === "final-qc")
    await store.pairs.updateOne(
      { _id: new ObjectId(unit.pairId) },
      { $set: { hamtaStatus: "pending" } },
      { session },
    );
  await history(
    store,
    String(unit._id),
    "unit." + milestone,
    actorId,
    unit.scope,
    { pairId: unit.pairId },
    session,
  );
  return publicRow(row);
}
