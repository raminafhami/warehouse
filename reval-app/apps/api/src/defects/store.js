/** @typedef {import("mongodb").ObjectId} Id */
/** @typedef {import("../identity/permissions.js").Scope} Scope */
/** @typedef {"technical"|"escalated"|"replacing"|"rework"|"retest"|"resolved"|"retest_failed"} CaseStatus */
/** @typedef {{_id:Id,visitId:string,unitCode:string,scope:Scope,testId:string,testName:string,resultId:string,status:CaseStatus,version:number,reason:string,at:Date,actorId:string,partId?:string,replacementId?:string,decisions?:{action:string,reason:string,resultId?:string,actorId:string,at:Date}[]}} Defect */
/** @typedef {{_id:Id,code:string,scope:Scope,supplierId:string,supplierName:string,parts:{id:string,code:string,skuCode:string,quantity:string}[],status:"prepared"|"dispatched"|"delivered",version:number,at:Date,events:{action:string,actorId:string,at:Date,reference?:string}[]}} ReturnDocument */

/** @param {import("mongoose").Connection} database */
export function defectCollections(database) {
  const db = database.db;
  if (!db) throw new Error("Defects database is unavailable.");
  return {
    defects: /** @type {import("mongodb").Collection<Defect>} */ (
      db.collection("reval_defects")
    ),
    returns: /** @type {import("mongodb").Collection<ReturnDocument>} */ (
      db.collection("reval_supplier_returns")
    ),
  };
}
/** @param {ReturnType<typeof defectCollections> & Pick<import("../assembly/store.js").Store,"counters">} store */
export async function initializeDefects(store) {
  await store.defects.createIndex(
    { visitId: 1, testId: 1 },
    {
      unique: true,
      partialFilterExpression: {
        status: {
          $in: ["technical", "escalated", "replacing", "rework", "retest"],
        },
      },
    },
  );
  await store.defects.createIndex({ "scope.lineId": 1, status: 1, at: -1 });
  await store.returns.createIndex({ code: 1 }, { unique: true });
  await store.counters.updateOne(
    { _id: "supplier-return" },
    { $setOnInsert: { value: 0 } },
    { upsert: true },
  );
}
