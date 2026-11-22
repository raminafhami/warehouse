/** @typedef {import("mongodb").ObjectId} Id */
/** @typedef {import("../identity/permissions.js").Scope} Scope */
/** @typedef {{_id:Id,modelId:string,modelName:string,numbers:string[],importId:string,row:number,status:"free"|"allocated"|"void",unitId?:string,scope?:Scope,hamtaStatus?:HamtaStatus,hasError?:boolean,at:Date}} Pair */
/** @typedef {{_id:Id,source:string,modelId:string,modelName:string,accepted:number,errors:{row:number,code:string}[],actorId:string,at:Date}} Import */
/** @typedef {{_id:Id,code:string,modelId:string,modelName:string,colorId:string,colorName:string,lineId:string,lineName:string,scope:Scope,imeiSlots:number,bomVersionId:string,bomRevision:number,routingVersionId:string,routingRevision:number,count:number,allocated:number,replacementDue:number,version:number,at:Date}} Order */
/** @typedef {"pending"|"submitted"|"error"|"activated"} HamtaStatus */
/** @typedef {{_id:Id,code:string,orderId:string,orderCode:string,basketId?:string,modelId:string,modelName:string,scope:Scope,lineName:string,pairId:string,numbers:string[],state:"allocated"|"released"|"void",printedAt?:Date,qcPassedAt?:Date,hamtaStatus?:HamtaStatus,imeiError?:string,trackingCode?:string,hamtaEvidence?:string,evidenceFile?:EvidenceInfo,hamtaReason?:string,hamtaActorId?:string,hamtaAt?:Date,version:number,at:Date}} Unit */
/** @typedef {{_id:Id,unitId:string,name:string,type:string,content:import('mongodb').Binary,at:Date}} Evidence */
/** @typedef {{id:string,name:string}} EvidenceInfo */
/** @typedef {{_id:string,hash:string,scopes:Scope[],output:object,at:Date}} Command */
/** @typedef {{_id:Id,entityId:string,action:string,actorId:string,scope:Scope,detail:object,at:Date}} History */

/** @param {import("mongoose").Connection} database */
export function imeiStore(database) {
  const db = database.db;
  if (!db) throw new Error("IMEI database is unavailable.");
  return {
    database,
    pairs: /** @type {import("mongodb").Collection<Pair>} */ (
      db.collection("reval_imei_pairs")
    ),
    imports: /** @type {import("mongodb").Collection<Import>} */ (
      db.collection("reval_imei_imports")
    ),
    orders: /** @type {import("mongodb").Collection<Order>} */ (
      db.collection("reval_production_orders")
    ),
    units: /** @type {import("mongodb").Collection<Unit>} */ (
      db.collection("reval_phone_units")
    ),
    commands: /** @type {import("mongodb").Collection<Command>} */ (
      db.collection("reval_imei_commands")
    ),
    evidence: /** @type {import('mongodb').Collection<Evidence>} */ (
      db.collection("reval_hamta_evidence")
    ),
    history: /** @type {import("mongodb").Collection<History>} */ (
      db.collection("reval_imei_history")
    ),
    counters:
      /** @type {import("mongodb").Collection<{_id:string,value:number}>} */ (
        db.collection("reval_counters")
      ),
  };
}

/** @typedef {ReturnType<typeof imeiStore>} Store */

/** @param {Store} store */
export async function initializeImei(store) {
  // A unique multikey index shares the same namespace across both slots.
  await store.pairs.createIndex({ numbers: 1 }, { unique: true });
  await store.pairs.createIndex({ modelId: 1, status: 1, _id: 1 });
  await store.orders.createIndex({ code: 1 }, { unique: true });
  await store.units.createIndex({ code: 1 }, { unique: true });
  await store.units.createIndex({ orderId: 1, at: -1 });
  await store.history.createIndex({ entityId: 1, _id: -1 });
  for (const name of ["imei-import", "production-order", "phone-unit"])
    await store.counters.updateOne(
      { _id: name },
      { $setOnInsert: { value: 0 } },
      { upsert: true },
    );
}

/** @template {{_id:Id}} T @param {T} row */
export function publicRow(row) {
  const { _id, ...data } = row;
  return { id: String(_id), ...data };
}
