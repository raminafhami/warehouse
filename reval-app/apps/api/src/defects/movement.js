import { ObjectId } from "mongodb";
import { matchingStock } from "../basket/parts.js";
import { conflict, missing } from "../assembly/workflow.js";
import { objectId } from "../identity/validation.js";
import { decimal, minor } from "../inventory/amounts.js";

/** @typedef {import("../assembly/store.js").Store} Store */
/** @typedef {import("../basket/store.js").Part} Part */
/** @typedef {import("mongodb").ClientSession} Session */
/** @typedef {import("../shipments/store.js").StockAccount} Account */

/** @param {Store} store @param {Part} part @param {Account} from @param {Account} to @param {string} actorId @param {string} documentId @param {Session} session */
export async function move(
  store,
  part,
  from,
  to,
  actorId,
  documentId,
  session,
) {
  const source = await store.custody.findOne(
    {
      _id: objectId(part.custodyId),
      skuId: part.skuId,
      cartonId: part.cartonId,
      lineId: part.lineId,
      warehouseId: part.warehouseId,
    },
    { session },
  );
  if (!source) throw missing();
  const amount = minor(part.quantity.toString());
  /** @type {Partial<import("../inventory/store.js").Custody>} */
  const quantities = {};
  for (const account of /** @type {const} */ (["line", "consumed"])) {
    const delta =
      (to === account ? amount : 0n) - (from === account ? amount : 0n);
    if (!delta) continue;
    const total = minor(source[account]?.toString() ?? "0") + delta;
    if (total < 0n) throw conflict("موجودی کارتن برای این عملیات کافی نیست.");
    quantities[account] = decimal(total);
  }
  if (Object.keys(quantities).length)
    await store.custody.updateOne(
      { _id: source._id },
      { $set: quantities },
      { session },
    );
  await store.ledger.insertOne(
    {
      _id: String(new ObjectId()),
      documentType: "defect.movement",
      documentId,
      skuId: part.skuId,
      cartonId: part.cartonId,
      warehouseId: part.warehouseId,
      scope: part.scope,
      fromScope: source.warehouseScope,
      lineId: part.lineId,
      basketId: part.basketId,
      partId: String(part._id),
      unitId: part.unitId,
      from,
      to,
      quantity: part.quantity,
      actorId,
      at: new Date(),
    },
    { session },
  );
}

/** @param {Store} store @param {import("../basket/store.js").Basket} basket @param {Part} part @param {unknown} [custodyId] @param {Session} [session] */
export function replacementStock(store, basket, part, custodyId, session) {
  return matchingStock(
    store,
    basket,
    {
      skuId: part.skuId,
      line: { $gte: part.quantity },
      ...(custodyId ? { _id: objectId(custodyId) } : {}),
    },
    session,
  );
}
