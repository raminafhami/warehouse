import { ObjectId } from "mongodb";
import { catalogStore } from "../catalog/store.js";
import { activeReference } from "../catalog/records.js";
import { idText } from "../catalog/validation.js";
import { ApiError } from "../http-error.js";
import { fields, text } from "../identity/validation.js";
import { publicRow } from "./store.js";

/** @typedef {import("./store.js").Store} Store */
/** @typedef {import("mongodb").ClientSession} Session */
/** @typedef {import("./store.js").Import} Import */
/** @typedef {import("./store.js").Pair} Pair */

export const maxImportRows = 1000;

/** @param {string} input */
export function latinDigits(input) {
  return input.replace(/[۰-۹٠-٩]/g, (digit) =>
    String(digit.charCodeAt(0) & 15),
  );
}

/** @param {unknown} input */
export function normalizeImei(input) {
  if (typeof input !== "string") return null;
  const number = latinDigits(input).replace(/[\s-]/g, "");
  if (!/^\d{15}$/.test(number)) return null;
  let sum = 0;
  for (const [index, digit] of [...number].entries()) {
    const n = Number(digit) * (index % 2 === 0 ? 1 : 2);
    sum += n > 9 ? n - 9 : n;
  }
  return sum % 10 === 0 ? number : null;
}

/** @param {Store} store @param {unknown} input @param {string} actorId @param {Session} session */
export async function importPairs(store, input, actorId, session) {
  const body = fields(input);
  const modelId = idText(body.modelId);
  const source = text(body.source, 200);
  if (
    !Array.isArray(body.rows) ||
    !body.rows.length ||
    body.rows.length > maxImportRows
  )
    throw new ApiError(
      400,
      "INVALID_IMEI_IMPORT",
      "هر بار بین ۱ و ۱۰۰۰ ردیف IMEI وارد کنید.",
    );
  // Serialize imports before reading the global number index. A racing import
  // retries its transaction and reports committed duplicates as row errors.
  await store.counters.updateOne(
    { _id: "imei-import" },
    { $inc: { value: 1 } },
    { session },
  );
  const model = await activeReference(
    catalogStore(store.database),
    "models",
    modelId,
    session,
  );
  const slots = Number(model.data.imeiSlots);
  const reportId = new ObjectId();
  const at = new Date();
  /** @type {Import["errors"]} */
  const errors = [];
  /** @type {Pair[]} */
  const candidates = [];
  let previousRow = 0;
  for (const item of body.rows) {
    const row = fields(item);
    if (
      !Number.isSafeInteger(row.row) ||
      Number(row.row) <= previousRow ||
      Number(row.row) > 1048576 ||
      !Array.isArray(row.cells)
    )
      throw new ApiError(
        400,
        "INVALID_IMEI_IMPORT",
        "ساختار ردیف ورودی معتبر نیست.",
      );
    const cells = row.cells;
    const rowNumber = Number(row.row);
    previousRow = rowNumber;
    if (cells.length !== slots) {
      errors.push({ row: rowNumber, code: "SLOTS" });
      continue;
    }
    const numbers = cells.map(normalizeImei);
    if (!numbers.every((number) => number !== null)) {
      errors.push({ row: rowNumber, code: "CHECK_DIGIT" });
      continue;
    }
    if (new Set(numbers).size !== numbers.length) {
      errors.push({ row: rowNumber, code: "SAME_PAIR" });
      continue;
    }
    candidates.push({
      _id: new ObjectId(),
      modelId,
      modelName: model.name,
      numbers,
      importId: String(reportId),
      row: rowNumber,
      status: "free",
      at,
    });
  }
  const used = new Set();
  if (candidates.length) {
    const numbers = [...new Set(candidates.flatMap(({ numbers }) => numbers))];
    const existing = await store.pairs
      .find(
        { numbers: { $in: numbers } },
        { session, projection: { numbers: 1 } },
      )
      .toArray();
    for (const pair of existing)
      for (const number of pair.numbers) used.add(number);
  }
  const accepted = candidates.filter((pair) => {
    if (pair.numbers.some((number) => used.has(number))) {
      errors.push({ row: pair.row, code: "DUPLICATE" });
      return false;
    }
    for (const number of pair.numbers) used.add(number);
    return true;
  });
  if (accepted.length) await store.pairs.insertMany(accepted, { session });
  const report = {
    _id: reportId,
    source,
    modelId,
    modelName: model.name,
    accepted: accepted.length,
    errors: errors.sort((a, b) => a.row - b.row),
    actorId,
    at,
  };
  await store.imports.insertOne(report, { session });
  return publicRow(report);
}
