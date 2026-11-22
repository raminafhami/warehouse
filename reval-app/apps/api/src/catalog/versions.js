import { ObjectId } from "mongodb";
import { ApiError } from "../http-error.js";
import { fields, text } from "../identity/validation.js";
import { activeReference } from "./records.js";
import { catalogCode, idText, invalid, list, quantity } from "./validation.js";

/** @typedef {ReturnType<typeof import("./store.js").catalogStore>} Store */
/** @typedef {import("./store.js").Revision} Revision */
/** @typedef {import("mongodb").ClientSession} Session */
/** @typedef {import("../identity/permissions.js").Scope} Scope */

/** @param {unknown} input */
export function versionType(input) {
  if (input !== "bom" && input !== "routing")
    throw invalid("نوع نسخه نامعتبر است.");
  return input;
}

/** @param {Store} store @param {unknown} input @param {Session} session */
async function bomLines(store, input, session) {
  const rows = list(input).map(fields);
  const seen = new Set();
  /** @type {import("./store.js").BomLine[]} */
  const lines = [];
  for (const row of rows) {
    const skuId = idText(row.skuId);
    if (seen.has(skuId)) throw invalid("کد کالا در فهرست BOM تکرار شده است.");
    seen.add(skuId);
    const sku = await activeReference(store, "skus", skuId, session);
    const part = await activeReference(
      store,
      "partTypes",
      String(sku.data.partTypeId),
      session,
    );
    await activeReference(
      store,
      "suppliers",
      String(sku.data.supplierId),
      session,
    );
    const unitId = String(part.data.unitId);
    const unit = await activeReference(store, "units", unitId, session);
    const scale = Number(unit.data.scale);
    if (
      quantity(row.quantity, scale) % quantity(unit.data.step, scale) !==
      0n
    ) {
      throw invalid("مقدار با گام واحد شمارش سازگار نیست.");
    }
    const stationCode = catalogCode("stations", row.stationCode);
    const station = await store.records.findOne(
      { kind: "stations", code: stationCode, active: true },
      { session, sort: { _id: 1 } },
    );
    if (!station)
      throw invalid("کد ایستگاه نصب این قطعه فعال یا تعریف‌شده نیست.");
    await activeReference(store, "stations", String(station._id), session);
    const quantityText = String(row.quantity).replace(
      /(\.\d*?[1-9])0+$|\.0+$/,
      "$1",
    );
    lines.push({
      skuId,
      skuCode: sku.code,
      quantity: quantityText,
      unitId,
      stationCode,
    });
  }
  return lines.sort((a, b) => a.skuId.localeCompare(b.skuId));
}

/** @param {Store} store @param {string} lineId @param {unknown} input @param {Session} session */
async function routingSteps(store, lineId, input, session) {
  const ids = list(input).map(idText);
  if (new Set(ids).size !== ids.length)
    throw invalid("ایستگاه در مسیر تولید تکرار شده است.");
  /** @type {import("./store.js").RouteStep[]} */
  const steps = [];
  for (const stationId of ids) {
    const station = await activeReference(
      store,
      "stations",
      stationId,
      session,
    );
    if (station.parentId !== lineId)
      throw invalid("ایستگاه متعلق به خط انتخاب‌شده نیست.");
    const testIds = /** @type {string[]} */ (station.data.testIds);
    const tests = [];
    for (const id of testIds) {
      const test = await activeReference(store, "tests", id, session);
      tests.push({ code: test.code, name: test.name, ...test.data });
    }
    steps.push({
      stationId,
      stationCode: station.code,
      testIds,
      configuration: { ...station.data, stationName: station.name, tests },
    });
  }
  return steps;
}

/**
 * @param {Store} store @param {unknown} input @param {string} actorId @param {Session} session
 * @param {(scope: Scope) => void} authorize
 */
export async function publishVersion(
  store,
  input,
  actorId,
  session,
  authorize,
) {
  const body = fields(input);
  const type = versionType(body.type);
  const modelId = idText(body.modelId);
  const lineId = type === "routing" ? idText(body.lineId) : null;
  const line = lineId
    ? await activeReference(store, "lines", lineId, session)
    : null;
  const scope = line?.scope ?? {};
  authorize(scope);
  await activeReference(store, "models", modelId, session);
  const filter = /** @type {import("mongodb").Filter<Revision>} */ ({
    type,
    modelId,
    lineId,
  });
  const previous = await store.versions.findOne(filter, {
    sort: { revision: -1 },
    session,
  });
  const lines =
    type === "bom" ? await bomLines(store, body.lines, session) : undefined;
  const steps = lineId
    ? await routingSteps(store, lineId, body.stationIds, session)
    : undefined;
  if (steps) {
    const bom = await store.versions.findOne(
      { type: "bom", modelId, lineId: null },
      { sort: { revision: -1 }, session },
    );
    if (
      bom?.lines?.some(
        (entry) =>
          !steps.some((step) => step.stationCode === entry.stationCode),
      )
    ) {
      throw invalid(
        "مسیر انتخابی همهٔ ایستگاه‌های نصب BOM جاری را پوشش نمی‌دهد.",
      );
    }
  }
  if (lines) {
    const currentRoutes = await store.versions
      .aggregate(
        [
          { $match: { type: "routing", modelId } },
          { $sort: { revision: -1 } },
          { $group: { _id: "$lineId", steps: { $first: "$steps" } } },
        ],
        { session },
      )
      .toArray();
    if (
      currentRoutes.some((route) =>
        lines.some(
          (entry) =>
            !route.steps.some(
              (/** @type {import("./store.js").RouteStep} */ step) =>
                step.stationCode === entry.stationCode,
            ),
        ),
      )
    )
      throw invalid("یک مسیر جاری، همهٔ ایستگاه‌های BOM جدید را پوشش نمی‌دهد.");
  }
  if (
    previous &&
    JSON.stringify(previous.lines ?? previous.steps) ===
      JSON.stringify(lines ?? steps)
  ) {
    throw new ApiError(
      409,
      "NO_VERSION_CHANGE",
      "تغییری نسبت به نسخهٔ جاری ایجاد نشده است.",
    );
  }
  /** @type {Revision} */
  const published = {
    _id: new ObjectId(),
    type,
    modelId,
    lineId,
    scope,
    revision: (previous?.revision ?? 0) + 1,
    description: text(body.description, 300, true),
    createdAt: new Date(),
    createdBy: actorId,
    ...(lines ? { lines } : { steps }),
  };
  await store.versions.insertOne(published, { session });
  return published;
}

/** @param {Revision} version */
export function publicVersion(version) {
  const { _id, ...rest } = version;
  return { id: String(_id), ...rest };
}
