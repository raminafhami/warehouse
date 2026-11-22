import { handoverStore } from "../handover/store.js";
import { imeiStore } from "../imei/store.js";

/** @typedef {import("mongodb").ObjectId} Id */
/** @typedef {import("mongodb").Decimal128} Decimal */
/** @typedef {import("../identity/permissions.js").Scope} Scope */
/** @typedef {import("../catalog/store.js").BomLine} Need */
/** @typedef {"preparing"|"ready"|"handed_over"|"received"|"cancelled"} BasketStatus */
/** @typedef {{_id:Id,code:string,unitId:string,unitCode:string,orderId:string,orderCode:string,modelId:string,modelName:string,colorName:string,lineId:string,lineName:string,scope:Scope,bomVersionId:string,bomRevision:number,routingVersionId:string,needs:Need[],status:BasketStatus,version:number,confirmedPairId?:string,confirmedAt?:Date,confirmedBy?:string,handedBy?:string,handedAt?:Date,receivedBy?:string,receivedAt?:Date,at:Date}} Basket */
/** @typedef {{_id:Id,code:string,basketId:string,unitId:string,modelId:string,bomVersionId:string,skuId:string,skuCode:string,stationCode:string,custodyId:string,cartonId:string,cartonCode:string,warehouseId:string,lineId:string,scope:Scope,quantity:Decimal,state:"printed"|"allocated"|"void"|"returned"|"installed"|"defective"|"defect_store"|"supplier_return"|"replacement_reserved",defectId?:string,replacesPartId?:string,returnId?:string,defectReceivedAt?:Date,defectReceivedBy?:string,printedAt:Date,installedAt?:Date,installedBy?:string,visitId?:string,scannedAt?:Date,closedAt?:Date,reason?:string}} Part */

export const basketCollection = "reval_baskets";

/** @param {import("mongoose").Connection} database */
export function basketStore(database) {
  const db = database.db;
  if (!db) throw new Error("Basket database is unavailable.");
  return {
    ...handoverStore(database),
    imei: imeiStore(database),
    baskets: /** @type {import("mongodb").Collection<Basket>} */ (
      db.collection(basketCollection)
    ),
    basketCommands:
      /** @type {import("mongodb").Collection<import("../identity/commands.js").Command>} */ (
        db.collection("reval_basket_commands")
      ),
  };
}
/** @typedef {ReturnType<typeof basketStore>} Store */

/** @param {Store} store */
export async function initializeBasket(store) {
  await store.baskets.createIndex({ code: 1 }, { unique: true });
  await store.baskets.createIndex({ unitId: 1 }, { unique: true });
  await store.baskets.createIndex({ lineId: 1, status: 1, _id: -1 });
  await store.parts.createIndex({ code: 1 }, { unique: true });
  await store.parts.createIndex({ basketId: 1, _id: 1 });
  await store.parts.createIndex({ unitId: 1 });
  await store.parts.createIndex({ cartonId: 1, state: 1 });
  await store.custody.createIndex({ lineId: 1, skuId: 1 });
  await store.imei.units.createIndex({
    orderId: 1,
    state: 1,
    basketId: 1,
    _id: 1,
  });
  for (const name of ["production-basket", "basket-part"])
    await store.counters.updateOne(
      { _id: name },
      { $setOnInsert: { value: 0 } },
      { upsert: true },
    );
}
