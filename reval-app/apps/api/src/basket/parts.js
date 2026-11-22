import { ObjectId } from "mongodb";
import { catalogStore } from "../catalog/store.js";
import { lookup } from "../catalog/records.js";
import { nextCode } from "../handover/requests.js";
import { fields, objectId, text } from "../identity/validation.js";
import {
  amountText,
  commandAmount,
  decimal,
  minor,
} from "../inventory/amounts.js";
import { publicRow } from "../imei/store.js";
import {
  conflict,
  lockUnit,
  missing,
  requireConfirmed,
  scanCode,
  unitForBasket,
  updateBasket,
} from "./workflow.js";

/** @typedef {import("./store.js").Store} Store */
/** @typedef {import("./store.js").Basket} Basket */
/** @typedef {import("./store.js").Part} Part */
/** @typedef {import("../inventory/store.js").Custody} Custody */
/** @typedef {import("mongodb").ClientSession} Session */

const zero = decimal(0n);

/** @param {Part} row */
export function publicPart(row) {
  return {
    ...publicRow(row),
    quantity: amountText(minor(row.quantity.toString())),
  };
}

/** @param {Store} store @param {Basket} basket @param {Record<string,unknown>} filter @param {Session} [session] */
export function matchingStock(store, basket, filter, session) {
  return store.custody.aggregate(
    /** @type {import("mongodb").Document[]} */ ([
      {
        $match: {
          lineId: basket.lineId,
          skuId: { $in: basket.needs.map((need) => need.skuId) },
          line: { $gt: zero },
          ...filter,
        },
      },
      { $set: { requestKey: { $toObjectId: "$requestId" } } },
      {
        $lookup: {
          from: store.requests.collectionName,
          localField: "requestKey",
          foreignField: "_id",
          as: "request",
        },
      },
      { $match: { "request.modelId": basket.modelId } },
      { $project: { request: 0, requestKey: 0 } },
      { $sort: { cartonCode: 1, _id: 1 } },
      { $limit: 100 },
    ]),
    { session },
  );
}

/** @param {Store} store @param {Basket} basket @param {unknown} input @param {Session} session */
export async function createPartLabel(store, basket, input, session) {
  const body = fields(input);
  const unit = await unitForBasket(store, basket, session);
  requireConfirmed(basket, unit);
  const skuId = objectId(body.skuId).toHexString();
  const need = basket.needs.find((row) => row.skuId === skuId);
  if (!need) throw conflict("این قطعه در BOM گوشی تعریف نشده است.");
  const unitOfMeasure = await lookup(
    catalogStore(store.imei.database),
    "units",
    need.unitId,
    session,
  );
  if (!unitOfMeasure) throw missing();
  const quantity = commandAmount(body.quantity, {
    scale: Number(unitOfMeasure.data.scale),
    step: String(unitOfMeasure.data.step),
  });
  if (quantity <= 0n) throw conflict("مقدار برچسب باید مثبت باشد.");
  const basketId = String(basket._id);
  const active = await store.parts
    .find(
      { basketId, skuId, state: { $in: ["allocated", "printed"] } },
      { session },
    )
    .toArray();
  if (
    active.reduce(
      (sum, row) => sum + minor(row.quantity.toString()),
      quantity,
    ) > minor(need.quantity)
  )
    throw conflict("مقدار برچسب از نیاز باقیماندهٔ BOM بیشتر است.");
  const source = /** @type {Custody|null} */ (
    await matchingStock(
      store,
      basket,
      { _id: objectId(body.custodyId), skuId },
      session,
    ).next()
  );
  if (!source || minor(source.line.toString()) < quantity)
    throw conflict(
      "برای این قطعه و مدل، موجودی قابل تخصیص در کارتن خط کافی نیست.",
    );
  await lockUnit(store, unit, session);
  /** @type {Part} */
  const part = {
    _id: new ObjectId(),
    code: await nextCode(store, "basket-part", "PRT", session),
    basketId,
    unitId: basket.unitId,
    modelId: basket.modelId,
    bomVersionId: basket.bomVersionId,
    skuId,
    skuCode: need.skuCode,
    stationCode: need.stationCode,
    custodyId: String(source._id),
    cartonId: source.cartonId,
    cartonCode: source.cartonCode,
    warehouseId: source.warehouseId,
    lineId: basket.lineId,
    scope: basket.scope,
    quantity: decimal(quantity),
    state: "printed",
    printedAt: new Date(),
  };
  await store.parts.insertOne(part, { session });
  const next = await updateBasket(store, basket, {}, session);
  return { basket: publicRow(next), part: publicPart(part) };
}

/** @param {Store} store @param {Basket} basket @param {Part} part @param {boolean} returning @param {string} actorId @param {string} reason @param {Session} session */
async function movePart(
  store,
  basket,
  part,
  returning,
  actorId,
  reason,
  session,
) {
  const amount = minor(part.quantity.toString());
  const source = await store.custody.findOne(
    {
      _id: objectId(part.custodyId),
      cartonId: part.cartonId,
      lineId: basket.lineId,
      skuId: part.skuId,
    },
    { session },
  );
  if (!source) throw missing();
  const line = minor(source.line.toString());
  const inBasket = minor(source.basket?.toString() ?? "0");
  if (returning ? inBasket < amount : line < amount)
    throw conflict("ماندهٔ این کارتن برای گردش قطعه کافی نیست.");
  const delta = returning ? -amount : amount;
  await store.custody.updateOne(
    { _id: source._id },
    {
      $set: { line: decimal(line - delta), basket: decimal(inBasket + delta) },
    },
    { session },
  );
  const documentId = new ObjectId().toHexString();
  await store.ledger.insertOne(
    {
      _id: documentId,
      documentType: returning ? "basket.part.return" : "basket.part.allocate",
      documentId,
      skuId: part.skuId,
      cartonId: part.cartonId,
      warehouseId: part.warehouseId,
      scope: part.scope,
      fromScope: source.warehouseScope,
      lineId: part.lineId,
      basketId: part.basketId,
      partId: String(part._id),
      from: returning ? "basket" : "line",
      to: returning ? "line" : "basket",
      quantity: part.quantity,
      actorId,
      at: new Date(),
      ...(reason ? { reason } : {}),
    },
    { session },
  );
}

/** @param {Store} store @param {Basket} basket @param {unknown} input @param {string} actorId @param {Session} session */
export async function scanPart(store, basket, input, actorId, session) {
  const body = fields(input);
  const unit = await unitForBasket(store, basket, session);
  requireConfirmed(basket, unit);
  const skuId = objectId(body.skuId).toHexString();
  if (!basket.needs.some((need) => need.skuId === skuId))
    throw conflict("ردیف قطعه در سبد نامعتبر است.");
  const code = scanCode(text(body.code, 80));
  const part = await store.parts.findOne({ code }, { session });
  if (!part) throw missing();
  if (part.basketId !== String(basket._id))
    throw conflict("برچسب به سبد گوشی دیگری تعلق دارد.");
  if (
    part.skuId !== skuId ||
    part.modelId !== basket.modelId ||
    part.bomVersionId !== basket.bomVersionId
  )
    throw conflict("برچسب با مدل یا ردیف BOM این گوشی سازگار نیست.");
  if (part.state !== "printed")
    throw conflict("این برچسب قبلاً اسکن شده یا از اعتبار افتاده است.");
  const picked = await store.parts
    .find({ basketId: part.basketId, skuId, state: "allocated" }, { session })
    .toArray();
  const need = basket.needs.find((row) => row.skuId === skuId);
  if (
    !need ||
    picked.reduce(
      (sum, row) => sum + minor(row.quantity.toString()),
      minor(part.quantity.toString()),
    ) > minor(need.quantity)
  )
    throw conflict("مقدار اسکن از نیاز باقیماندهٔ BOM بیشتر است.");
  await lockUnit(store, unit, session);
  await movePart(store, basket, part, false, actorId, "", session);
  const updated = await store.parts.findOneAndUpdate(
    { _id: part._id, state: "printed" },
    { $set: { state: "allocated", scannedAt: new Date() } },
    { session, returnDocument: "after" },
  );
  if (!updated) throw conflict("این برچسب قبلاً اسکن شده است.");
  const next = await updateBasket(store, basket, {}, session);
  return { basket: publicRow(next), part: publicPart(updated) };
}

/** @param {Store} store @param {Basket} basket @param {unknown} id @param {unknown} input @param {string} actorId @param {Session} session */
export async function removePart(store, basket, id, input, actorId, session) {
  const part = await store.parts.findOne(
    { _id: objectId(id), basketId: String(basket._id) },
    { session },
  );
  if (!part) throw missing();
  if (part.state !== "printed" && part.state !== "allocated")
    throw conflict("این برچسب پیش‌تر بسته شده است.");
  const reason = text(fields(input).reason, 500);
  const returning = part.state === "allocated";
  if (returning)
    await movePart(store, basket, part, true, actorId, reason, session);
  const updated = await store.parts.findOneAndUpdate(
    { _id: part._id, state: part.state },
    {
      $set: {
        state: returning ? "returned" : "void",
        reason,
        closedAt: new Date(),
      },
    },
    { session, returnDocument: "after" },
  );
  if (!updated) throw conflict("وضعیت قطعه تغییر کرده است.");
  const next = await updateBasket(store, basket, {}, session);
  return { basket: publicRow(next), part: publicPart(updated) };
}
