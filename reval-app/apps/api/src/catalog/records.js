import { ObjectId } from "mongodb";
import { ApiError } from "../http-error.js";
import { fields, text, versionInput } from "../identity/validation.js";
import {
  catalogCode,
  catalogData,
  idText,
  invalid,
  kinds,
  parentKinds,
} from "./validation.js";

/** @typedef {ReturnType<typeof import("./store.js").catalogStore>} Store */
/** @typedef {import("./store.js").Kind} Kind */
/** @typedef {import("./store.js").Entry} Entry */
/** @typedef {import("mongodb").ClientSession} Session */
/** @typedef {import("../identity/permissions.js").Scope} Scope */

export const missing = () =>
  new ApiError(404, "CATALOG_NOT_FOUND", "رکورد اطلاعات پایه پیدا نشد.");
export const changed = () =>
  new ApiError(409, "CATALOG_CONFLICT", "رکورد تغییر کرده یا کد تکراری است.");

/** @param {Store} store @param {Kind} kind @param {string} id @param {Session} [session] */
export async function lookup(store, kind, id, session) {
  return store.records.findOne({ _id: new ObjectId(id), kind }, { session });
}

/** @param {Store} store @param {Kind} kind @param {string} id @param {Session} session */
export async function activeReference(store, kind, id, session) {
  const record = await store.records.findOneAndUpdate(
    { _id: new ObjectId(id), kind, active: true },
    { $inc: { referenceVersion: 1 } },
    { session, returnDocument: "after" },
  );
  if (!record) throw invalid(`رکورد فعال در «${kinds[kind]}» پیدا نشد.`);
  return record;
}

/** @param {Kind} kind @param {string} id @param {Scope} inherited */
function resourceScope(kind, id, inherited) {
  switch (kind) {
    case "branches":
      return { branchId: id };
    case "lines":
      return { ...inherited, lineId: id };
    case "stations":
      return { ...inherited, stationId: id };
    case "warehouses":
      return { ...inherited, warehouseId: id };
    default:
      return inherited;
  }
}

/** @param {Store} store @param {Kind} kind @param {Record<string, unknown>} data @param {Session} session */
async function validateReferences(store, kind, data, session) {
  /** @type {[Kind, string][]} */
  const references = [];
  if (kind === "partTypes") references.push(["units", String(data.unitId)]);
  if (kind === "skus")
    references.push(
      ["partTypes", String(data.partTypeId)],
      ["suppliers", String(data.supplierId)],
    );
  if (kind === "models")
    for (const id of /** @type {string[]} */ (data.colorIds))
      references.push(["colors", id]);
  if (kind === "stations")
    for (const id of /** @type {string[]} */ (data.testIds))
      references.push(["tests", id]);
  if (kind === "locations") {
    for (const id of /** @type {string[]} */ (data.allowedModelIds))
      references.push(["models", id]);
    for (const id of /** @type {string[]} */ (data.allowedPartTypeIds))
      references.push(["partTypes", id]);
  }
  if (kind === "tests" && data.partTypeId)
    references.push(["partTypes", String(data.partTypeId)]);
  for (const [type, id] of references)
    await activeReference(store, type, id, session);
  if (kind === "stations") {
    const allowedRoles = /** @type {string[]} */ (data.allowedRoleIds);
    const roles =
      /** @type {import("mongodb").Collection<import("../identity/store.js").Role>} */ (
        store.database.collection("reval_roles")
      );
    if (
      allowedRoles.length &&
      (await roles.countDocuments(
        { _id: { $in: allowedRoles } },
        { session },
      )) !== allowedRoles.length
    ) {
      throw invalid("یکی از شناسه‌های نقش ایستگاه معتبر نیست.");
    }
  }
}

/**
 * @param {Store} store @param {Kind} kind @param {unknown} value @param {Session} session
 * @param {(scope: Scope) => void} authorize
 */
export async function createRecord(store, kind, value, session, authorize) {
  const body = fields(value);
  const parentKind = parentKinds[kind];
  const parentId = parentKind ? idText(body.parentId) : null;
  const parent =
    parentId && parentKind
      ? await activeReference(store, parentKind, parentId, session)
      : null;
  const _id = new ObjectId();
  const scope = resourceScope(kind, String(_id), parent?.scope ?? {});
  authorize(scope);
  const data = catalogData(kind, body.data);
  await validateReferences(store, kind, data, session);
  /** @type {Entry} */
  const entry = {
    _id,
    kind,
    parentId,
    scope,
    data,
    code: catalogCode(kind, body.code),
    name: text(body.name),
    active: true,
    version: 0,
    referenceVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await store.records.insertOne(entry, { session });
  return entry;
}

/** @param {Store} store @param {Entry} record @param {Session} session */
async function rejectInUse(store, record, session) {
  const id = String(record._id);
  /** @type {Partial<Record<Kind, string[]>>} */
  const fieldsByKind = {
    units: ["data.unitId"],
    partTypes: ["data.partTypeId", "data.allowedPartTypeIds"],
    suppliers: ["data.supplierId"],
    colors: ["data.colorIds"],
    tests: ["data.testIds"],
  };
  const paths = fieldsByKind[record.kind] ?? [];
  const linked = await store.records.findOne(
    {
      active: true,
      $or: [{ parentId: id }, ...paths.map((path) => ({ [path]: id }))],
    },
    { session, projection: { _id: 1 } },
  );
  if (linked)
    throw new ApiError(
      409,
      "CATALOG_IN_USE",
      "این رکورد در اطلاعات پایهٔ فعال استفاده شده است.",
    );

  if (record.kind === "skus" || record.kind === "stations") {
    const field =
      record.kind === "skus"
        ? "version.lines.skuId"
        : "version.steps.stationId";
    const used = await store.versions
      .aggregate(
        [
          { $sort: { revision: -1 } },
          {
            $group: {
              _id: { type: "$type", modelId: "$modelId", lineId: "$lineId" },
              version: { $first: "$$ROOT" },
            },
          },
          { $match: { [field]: id } },
          { $limit: 1 },
        ],
        { session },
      )
      .hasNext();
    if (used)
      throw new ApiError(
        409,
        "CATALOG_IN_USE",
        "این رکورد در نسخهٔ جاری تولید استفاده شده است.",
      );
    if (record.kind === "stations") {
      const sameCode = await store.records.findOne(
        {
          kind: "stations",
          code: record.code,
          active: true,
          _id: { $ne: record._id },
        },
        { session },
      );
      if (sameCode)
        await activeReference(store, "stations", String(sameCode._id), session);
      if (
        !sameCode &&
        (await store.versions
          .aggregate(
            [
              { $match: { type: "bom" } },
              { $sort: { revision: -1 } },
              { $group: { _id: "$modelId", version: { $first: "$$ROOT" } } },
              { $match: { "version.lines.stationCode": record.code } },
              { $limit: 1 },
            ],
            { session },
          )
          .hasNext())
      )
        throw new ApiError(
          409,
          "CATALOG_IN_USE",
          "کد ایستگاه در نسخهٔ جاری BOM استفاده شده است.",
        );
    }
  }
}

/** @param {Store} store @param {Entry} current @param {unknown} value @param {Session} session */
export async function updateRecord(store, current, value, session) {
  const body = fields(value);
  if (versionInput(body.version) !== current.version) throw changed();
  /** @type {Partial<Entry>} */
  const updates = {};
  if (typeof body.active === "boolean") {
    if (!body.active && current.active)
      await rejectInUse(store, current, session);
    if (body.active && !current.active) {
      const parentKind = parentKinds[current.kind];
      if (parentKind && current.parentId)
        await activeReference(store, parentKind, current.parentId, session);
      await validateReferences(store, current.kind, current.data, session);
    }
    updates.active = body.active;
  } else if (current.kind === "stations") {
    updates.name = text(body.name);
    updates.data = catalogData(current.kind, body.data);
    await validateReferences(store, current.kind, updates.data, session);
  } else {
    throw invalid("تغییر مجاز برای این رکورد مشخص نشده است.");
  }
  const after = await store.records.findOneAndUpdate(
    { _id: current._id, version: current.version },
    { $set: { ...updates, updatedAt: new Date() }, $inc: { version: 1 } },
    { returnDocument: "after", session },
  );
  if (!after) throw changed();
  return after;
}

/** @param {Entry} location @param {{ modelId?: string, partTypeId?: string }} item */
export function checkLocationCompatibility(location, item) {
  const models = /** @type {string[]} */ (location.data.allowedModelIds);
  const types = /** @type {string[]} */ (location.data.allowedPartTypeIds);
  if (
    (models.length && (!item.modelId || !models.includes(item.modelId))) ||
    (types.length && (!item.partTypeId || !types.includes(item.partTypeId)))
  ) {
    throw invalid("مدل یا نوع قطعه برای این موقعیت مجاز نیست.");
  }
}

/** @param {Store} store @param {Scope[]} scopes @param {Session} session */
export async function validateScopeReferences(store, scopes, session) {
  const references = /** @type {const} */ ({
    branchId: "branches",
    warehouseId: "warehouses",
    lineId: "lines",
    stationId: "stations",
  });
  const keys = /** @type {(keyof Scope)[]} */ (Object.keys(references));
  for (const scope of scopes) {
    /** @type {Scope} */
    const resolved = {};
    for (const key of keys) {
      const id = scope[key];
      if (!id) continue;
      const record = await activeReference(store, references[key], id, session);
      if (
        keys.some(
          (field) =>
            resolved[field] &&
            record.scope[field] &&
            resolved[field] !== record.scope[field],
        )
      ) {
        throw invalid(
          "شعبه، انبار، خط یا ایستگاه انتخاب‌شده در یک محدوده نیستند.",
        );
      }
      Object.assign(resolved, record.scope);
    }
  }
}
