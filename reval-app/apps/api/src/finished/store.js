/** @typedef {import("mongodb").ObjectId} Id */
/** @typedef {import("../identity/permissions.js").Scope} Scope */
/** @typedef {{_id:Id,round:number,version:number,status:"testing"|"rework"|"passed"|"packed",labelPairId?:string,labelAt?:Date,labelBy?:string,packedAt?:Date,packedBy?:string,cartonId?:string}} FinalRecord */
/** @typedef {{_id:Id,unitId:string,round:number,item:string,outcome:"pass"|"fail",at:Date,actorId:string}} Check */
/** @typedef {{_id:Id,unitId:string,round:number,stationId:string,reason:string,at:Date,actorId:string}} Rejection */
/** @typedef {{_id:Id,code:string,scope:Scope,modelId:string,colorId:string,modelName:string,colorName:string,capacity:number,status:"open"|"closed"|"placed",version:number,members:{unitId:string,unitCode:string,numbers:string[]}[],at:Date,labelVersion?:number,labelAt?:Date,closedAt?:Date,locationId?:string,locationName?:string,placedAt?:Date}} Carton */

/** @param {import("mongoose").Connection} database */
export function finishedCollections(database) {
  const db = database.db;
  if (!db) throw Error("Finished goods database is unavailable.");
  return {
    final: /** @type {import("mongodb").Collection<FinalRecord>} */ (
      db.collection("reval_final_records")
    ),
    finalChecks: /** @type {import("mongodb").Collection<Check>} */ (
      db.collection("reval_final_checks")
    ),
    finalRejections: /** @type {import("mongodb").Collection<Rejection>} */ (
      db.collection("reval_final_rejections")
    ),
    finishedCartons: /** @type {import("mongodb").Collection<Carton>} */ (
      db.collection("reval_finished_cartons")
    ),
  };
}
/** @param {ReturnType<typeof finishedCollections> & Pick<import("../assembly/store.js").Store,"counters">} store */
export async function initializeFinished(store) {
  await store.final.createIndex({ status: 1, cartonId: 1 });
  await store.finalChecks.createIndex(
    { unitId: 1, round: 1, item: 1 },
    { unique: true },
  );
  await store.finalRejections.createIndex(
    { unitId: 1, round: 1 },
    { unique: true },
  );
  await store.finishedCartons.createIndex({ code: 1 }, { unique: true });
  await store.finishedCartons.createIndex({ "members.unitId": 1, status: 1 });
  await store.finishedCartons.createIndex({
    "scope.warehouseId": 1,
    status: 1,
    _id: -1,
  });
  await store.counters.updateOne(
    { _id: "finished-carton" },
    { $setOnInsert: { value: 0 } },
    { upsert: true },
  );
}
