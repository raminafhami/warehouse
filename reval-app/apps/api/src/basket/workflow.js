import { ObjectId } from "mongodb";
import { catalogStore } from "../catalog/store.js";
import { activeReference } from "../catalog/records.js";
import { ApiError } from "../http-error.js";
import { nextCode } from "../handover/requests.js";
import {
  fields,
  objectId,
  text,
  versionInput,
} from "../identity/validation.js";
import { latinDigits, normalizeImei } from "../imei/imports.js";
import { allocateUnit, history, recordMilestone } from "../imei/orders.js";
import { publicRow } from "../imei/store.js";
import { minor } from "../inventory/amounts.js";

/** @typedef {import("./store.js").Store} Store */
/** @typedef {import("./store.js").Basket} Basket */
/** @typedef {import("../imei/store.js").Unit} Unit */
/** @typedef {import("mongodb").ClientSession} Session */

export const missing = () =>
  new ApiError(404, "BASKET_NOT_FOUND", "سبد، گوشی یا قطعه پیدا نشد.");
/** @param {string} message */
export const conflict = (message) =>
  new ApiError(409, "BASKET_CONFLICT", message);

/** @param {Store} store @param {Basket} basket @param {Session} [session] */
export async function unitForBasket(store, basket, session) {
  const unit = await store.imei.units.findOne(
    { _id: objectId(basket.unitId), basketId: String(basket._id) },
    { session },
  );
  if (!unit) throw missing();
  return unit;
}

/** @param {Unit} unit */
function allocated(unit) {
  if (unit.state !== "allocated" || unit.imeiError)
    throw conflict("تخصیص IMEI گوشی باید معتبر و بدون خطای باز باشد.");
}

/** @param {Basket} basket @param {Unit} unit */
export function requireConfirmed(basket, unit) {
  allocated(unit);
  if (basket.confirmedPairId !== unit.pairId)
    throw conflict("ابتدا برچسب IMEI فعلی را چاپ و با اسکن تأیید کنید.");
}

/** @param {Store} store @param {Basket} basket @param {Partial<Basket>} set @param {Session} session */
export async function updateBasket(store, basket, set, session) {
  const next = await store.baskets.findOneAndUpdate(
    { _id: basket._id, version: basket.version },
    { $set: set, $inc: { version: 1 } },
    { session, returnDocument: "after" },
  );
  if (!next) throw conflict("سبد تغییر کرده است. دوباره بارگیری کنید.");
  return next;
}

/** @param {Basket} basket @param {unknown} input @param {Basket["status"][]} statuses */
export function assertVersion(basket, input, statuses) {
  if (basket.version !== versionInput(fields(input).version))
    throw conflict("سبد تغییر کرده است. دوباره بارگیری کنید.");
  if (!statuses.includes(basket.status))
    throw conflict("وضعیت فعلی سبد برای این عملیات معتبر نیست.");
}

/** @param {Store} store @param {import("../imei/store.js").Order} order @param {string} actorId @param {Session} session */
export async function prepareBasket(store, order, actorId, session) {
  const catalog = catalogStore(store.imei.database);
  await activeReference(catalog, "lines", order.lineId, session);
  const bom = await catalog.versions.findOne(
    { _id: objectId(order.bomVersionId), type: "bom", modelId: order.modelId },
    { session },
  );
  if (!bom?.lines?.length)
    throw conflict("نسخهٔ BOM دستور تولید در دسترس نیست.");
  const existing = await store.imei.units.findOne(
    {
      orderId: String(order._id),
      state: "allocated",
      basketId: { $exists: false },
      imeiError: { $exists: false },
      hamtaStatus: { $exists: false },
    },
    { session, sort: { _id: 1 } },
  );
  const unit = existing
    ? publicRow(existing)
    : await allocateUnit(store.imei, order, actorId, session);
  const _id = new ObjectId();
  const attached = await store.imei.units.updateOne(
    {
      _id: objectId(unit.id),
      version: unit.version,
      basketId: { $exists: false },
    },
    { $set: { basketId: String(_id) }, $inc: { version: 1 } },
    { session },
  );
  if (!attached.modifiedCount)
    throw conflict("گوشی پیش‌تر به سبد دیگری وصل شده است.");
  /** @type {Basket} */
  const row = {
    _id,
    code: await nextCode(store, "production-basket", "BSK", session),
    unitId: unit.id,
    unitCode: unit.code,
    orderId: String(order._id),
    orderCode: order.code,
    modelId: order.modelId,
    modelName: order.modelName,
    colorName: order.colorName,
    lineId: order.lineId,
    lineName: order.lineName,
    scope: order.scope,
    bomVersionId: order.bomVersionId,
    bomRevision: order.bomRevision,
    routingVersionId: order.routingVersionId,
    needs: bom.lines,
    status: "preparing",
    version: 0,
    at: new Date(),
  };
  await store.baskets.insertOne(row, { session });
  return publicRow(row);
}

/** @param {Store} store @param {Basket} basket @param {string} actorId @param {Session} session */
export async function printImei(store, basket, actorId, session) {
  const unit = await unitForBasket(store, basket, session);
  allocated(unit);
  await recordMilestone(store.imei, unit, "printed", actorId, session);
  const next = await updateBasket(store, basket, {}, session);
  return { basket: publicRow(next) };
}

/** @param {Store} store @param {Basket} basket @param {unknown} input @param {string} actorId @param {Session} session */
export async function confirmImei(store, basket, input, actorId, session) {
  const unit = await unitForBasket(store, basket, session);
  allocated(unit);
  if (!unit.printedAt) throw conflict("ابتدا برچسب IMEI گوشی را چاپ کنید.");
  if (basket.confirmedPairId === unit.pairId)
    throw conflict("IMEI فعلی گوشی قبلاً تأیید شده است.");
  const code = normalizeImei(text(fields(input).code, 40));
  if (!code || !unit.numbers.includes(code))
    throw conflict("IMEI اسکن‌شده متعلق به این گوشی نیست.");
  const at = new Date();
  await lockUnit(store, unit, session);
  await history(
    store.imei,
    basket.unitId,
    "unit.imei-confirm",
    actorId,
    basket.scope,
    {
      basketId: String(basket._id),
      pairId: unit.pairId,
      slot: unit.numbers.indexOf(code) + 1,
    },
    session,
  );
  return publicRow(
    await updateBasket(
      store,
      basket,
      { confirmedPairId: unit.pairId, confirmedAt: at, confirmedBy: actorId },
      session,
    ),
  );
}

/** @param {Store} store @param {Unit} unit @param {Session} session */
export async function lockUnit(store, unit, session) {
  const touched = await store.imei.units.updateOne(
    { _id: unit._id, version: unit.version },
    { $inc: { version: 1 } },
    { session },
  );
  if (!touched.modifiedCount) throw conflict("IMEI گوشی تغییر کرده است.");
}

/** @param {string} input */
export const scanCode = (input) => latinDigits(input).trim().toUpperCase();

/** @param {Store} store @param {Basket} basket @param {"ready"|"handed_over"|"received"} state @param {string} actorId @param {Session} session */
export async function advance(store, basket, state, actorId, session) {
  const unit = await unitForBasket(store, basket, session);
  requireConfirmed(basket, unit);
  if (state === "ready") {
    const parts = await store.parts
      .find({ basketId: String(basket._id), state: "allocated" }, { session })
      .toArray();
    const amounts = new Map();
    for (const part of parts)
      amounts.set(
        part.skuId,
        (amounts.get(part.skuId) ?? 0n) + minor(part.quantity.toString()),
      );
    const incomplete = basket.needs.filter(
      (need) => minor(need.quantity) !== (amounts.get(need.skuId) ?? 0n),
    );
    if (incomplete.length)
      throw conflict(
        "سبد کامل نیست. قطعهٔ باقیمانده: " +
          incomplete.map((need) => need.skuCode).join("، "),
      );
  }
  if (state === "received" && actorId === basket.handedBy)
    throw new ApiError(
      403,
      "SENDER_CANNOT_RECEIVE",
      "تحویل‌دهنده نمی‌تواند دریافت همین سبد را تأیید کند.",
    );
  await lockUnit(store, unit, session);
  const change = {
    status: state,
    ...(state === "handed_over"
      ? { handedBy: actorId, handedAt: new Date() }
      : {}),
    ...(state === "received"
      ? { receivedBy: actorId, receivedAt: new Date() }
      : {}),
  };
  return publicRow(await updateBasket(store, basket, change, session));
}
