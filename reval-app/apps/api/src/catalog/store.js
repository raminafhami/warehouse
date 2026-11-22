/** @typedef {import("mongodb").ObjectId} ObjectId */
/** @typedef {import("../identity/permissions.js").Scope} Scope */
/** @typedef {"partTypes" | "suppliers" | "skus" | "units" | "models" | "colors" | "branches" | "lines" | "stations" | "tests" | "warehouses" | "locations"} Kind */
/** @typedef {{ _id: ObjectId, kind: Kind, code: string, name: string, parentId: string | null, scope: Scope, data: Record<string, unknown>, active: boolean, version: number, referenceVersion: number, createdAt: Date, updatedAt: Date }} Entry */
/** @typedef {{ skuId: string, quantity: string, stationCode: string, skuCode: string, unitId: string }} BomLine */
/** @typedef {{ stationId: string, stationCode: string, testIds: string[], configuration: Record<string, unknown> }} RouteStep */
/** @typedef {{ _id: ObjectId, type: "bom" | "routing", modelId: string, lineId: string | null, scope: Scope, revision: number, description: string, createdAt: Date, createdBy: string, lines?: BomLine[], steps?: RouteStep[] }} Revision */

/** @param {import("mongoose").Connection} database */
export function catalogStore(database) {
  if (!database.db) throw new Error("Catalog database is unavailable.");
  return {
    records: /** @type {import("mongodb").Collection<Entry>} */ (
      database.db.collection("reval_catalog")
    ),
    versions: /** @type {import("mongodb").Collection<Revision>} */ (
      database.db.collection("reval_catalog_versions")
    ),
    database,
  };
}

/** @param {ReturnType<typeof catalogStore>} store */
export async function initializeCatalog(store) {
  await store.records.createIndex(
    { kind: 1, parentId: 1, code: 1 },
    { unique: true },
  );
  await store.records.createIndex({ kind: 1, active: 1, code: 1 });
  await store.versions.createIndex(
    { type: 1, modelId: 1, lineId: 1, revision: -1 },
    { unique: true },
  );
  await store.versions.createIndex({ "lines.skuId": 1 });
  await store.versions.createIndex({ "steps.stationId": 1 });
}

/** @param {Entry} entry */
export function publicEntry(entry) {
  const {
    _id,
    kind,
    code,
    name,
    parentId,
    scope,
    data,
    active,
    version,
    createdAt,
    updatedAt,
  } = entry;
  return {
    id: String(_id),
    kind,
    code,
    name,
    parentId,
    scope,
    data,
    active,
    version,
    createdAt,
    updatedAt,
  };
}
