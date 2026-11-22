import { inventoryStore } from "../inventory/store.js";
import { amountText, minor } from "../inventory/amounts.js";

/** @typedef {import("mongodb").ObjectId} Id */
/** @typedef {import("../identity/permissions.js").Scope} Scope */
/** @typedef {{skuId:string,skuCode:string,required:string,issued:string}} Need */
/** @typedef {{_id:Id,code:string,modelId:string,modelName:string,bomVersionId:string,bomRevision:number,warehouseId:string,warehouseName:string,warehouseScope:Scope,lineId:string,lineName:string,lineScope:Scope,combinedScope?:Scope,count:number,needs:Need[],status:"open"|"partial"|"fulfilled"|"cancelled",version:number,actorId:string,at:Date,cancellationReason?:string}} MaterialRequest */
/** @typedef {{_id:Id,code:string,requestId:string,issuerId:string,receiverId?:string,at:Date,version:number,status:"issued"|"received"|"discrepancy"|"partial"|"returned",reason?:string,updatedAt?:Date}} Delivery */
/** @typedef {{_id:string,hash:string,result:object,at:Date}} Receipt */

/** @param {import("mongoose").Connection} database */
export function handoverStore(database) {
  const db = database.db;
  if (!db) throw new Error("Handover database is unavailable.");
  return {
    database,
    ...inventoryStore(database),
    requests: /** @type {import("mongodb").Collection<MaterialRequest>} */ (
      db.collection("reval_material_requests")
    ),
    deliveries: /** @type {import("mongodb").Collection<Delivery>} */ (
      db.collection("reval_material_deliveries")
    ),
    handoverCommands: /** @type {import("mongodb").Collection<Receipt>} */ (
      db.collection("reval_handover_commands")
    ),
  };
}

/** @param {ReturnType<typeof handoverStore>} store */
export async function initializeHandover(store) {
  await store.requests.createIndex({ code: 1 }, { unique: true });
  await store.requests.createIndex({ warehouseId: 1, at: -1 });
  await store.requests.createIndex({ lineId: 1, at: -1 });
  await store.deliveries.createIndex({ requestId: 1, at: -1 });
  await store.deliveries.createIndex({ code: 1 }, { unique: true });
  await store.custody.createIndex({ deliveryId: 1 });
  await store.custody.createIndex({ cartonId: 1, warehouseId: 1 });
  await store.reservations.createIndex({ requestId: 1, state: 1 });
  for (const name of ["material-request", "material-delivery"]) {
    await store.counters.updateOne(
      { _id: name },
      { $setOnInsert: { value: 0 } },
      { upsert: true },
    );
  }
}

/** @param {MaterialRequest} row */
export function publicRequest(row) {
  const { _id, ...data } = row;
  return { id: String(_id), ...data };
}
/** @param {Delivery} row */
export function publicDelivery(row) {
  const { _id, ...data } = row;
  return { id: String(_id), ...data };
}
/** @param {import("../inventory/store.js").Custody} row */
export function publicCustody(row) {
  const { _id, issued, transit, line, basket, consumed, returned, ...data } =
    row;
  return {
    id: String(_id),
    ...data,
    issued: amountText(minor(issued.toString())),
    transit: amountText(minor(transit.toString())),
    line: amountText(minor(line.toString())),
    basket: amountText(minor(basket?.toString() ?? "0")),
    consumed: amountText(minor(consumed?.toString() ?? "0")),
    returned: amountText(minor(returned.toString())),
  };
}
