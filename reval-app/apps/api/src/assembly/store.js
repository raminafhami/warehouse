import { finishedCollections } from "../finished/store.js";
import { defectCollections } from "../defects/store.js";
import { basketStore } from "../basket/store.js";
import { catalogStore } from "../catalog/store.js";

/** @typedef {import("mongodb").ObjectId} Id */
/** @typedef {import("../identity/permissions.js").Scope} Scope */
/** @typedef {{_id:Id, next:number, reworkRound?:number, visitId?:Id}} Position */
/** @typedef {{_id:Id, unitId:string, unitCode:string, basketId:string, scope:Scope, modelName:string, lineName:string, stationCode:string, stationName:string, index:number, routeIndex?:number, routingVersionId:string, status:"installing"|"testing"|"transferred", version:number, entryAt:Date, enteredBy:string, enteredName?:string, completedAt?:Date, completedBy?:string, checklist?:boolean[], exitAt?:Date, exitedBy?:string}} Visit */
/** @typedef {"pass"|"fail"|"review"} Outcome */
/** @typedef {{_id:Id, visitId:string, unitId:string, unitCode:string, modelName:string, stationName:string, scope:Scope, routingVersionId:string, testId:string, testCode:string, testName:string, answer:string, outcome:Outcome, attempt:number, revision:number, replacesId?:string, reason?:string, actorId:string, at:Date}} Result */

/** @param {import("mongoose").Connection} database */
export function assemblyStore(database) {
  const db = database.db;
  if (!db) throw new Error("Assembly database is unavailable.");
  return {
    ...basketStore(database),
    ...defectCollections(database),
    ...finishedCollections(database),
    catalog: catalogStore(database),
    positions: /** @type {import("mongodb").Collection<Position>} */ (
      db.collection("reval_assembly_positions")
    ),
    visits: /** @type {import("mongodb").Collection<Visit>} */ (
      db.collection("reval_station_visits")
    ),
    results: /** @type {import("mongodb").Collection<Result>} */ (
      db.collection("reval_stage_results")
    ),
    assemblyCommands:
      /** @type {import("mongodb").Collection<import("../identity/commands.js").Command>} */ (
        db.collection("reval_assembly_commands")
      ),
  };
}
/** @typedef {ReturnType<typeof assemblyStore>} Store */

/** @param {Store} store */
export async function initializeAssembly(store) {
  await store.visits.createIndex({ unitId: 1, index: 1 }, { unique: true });
  await store.visits.createIndex({
    "scope.stationId": 1,
    status: 1,
    entryAt: -1,
  });
  await store.results.createIndex(
    { visitId: 1, testId: 1, attempt: 1, revision: 1 },
    { unique: true },
  );
  await store.results.createIndex({ "scope.stationId": 1, at: -1 });
}
