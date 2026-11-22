import { ObjectId } from "mongodb";
import { fields, text } from "../identity/validation.js";
import { ApiError } from "../http-error.js";
import { checkUnitVersion, conflict, history } from "./orders.js";
import { publicRow } from "./store.js";

/** @typedef {import("./store.js").Store} Store */
/** @typedef {import("./store.js").Unit} Unit */
/** @typedef {import("mongodb").ClientSession} Session */

/** @param {unknown} action */
export function hamtaAction(action) {
  if (action !== "submit" && action !== "retry" && action !== "reconcile")
    throw new ApiError(400, "INVALID_HAMTA_ACTION", "نوع ثبت همتا معتبر نیست.");
  return action;
}

/** @param {unknown} input @returns {{hamtaStatus:"activated",trackingCode:string,hamtaEvidence:string}|{hamtaStatus:"submitted"|"error",hamtaReason:string}} */
export function manualResult(input) {
  const body = fields(input);
  const outcome = body.outcome;
  if (outcome === "activated") {
    const trackingCode = text(body.trackingCode, 100);
    return {
      hamtaStatus: /** @type {const} */ ("activated"),
      trackingCode,
      hamtaEvidence: text(body.evidence, 240, true),
    };
  }
  if (outcome === "submitted" || outcome === "error")
    return { hamtaStatus: outcome, hamtaReason: text(body.reason, 500) };
  throw new ApiError(
    400,
    "INVALID_HAMTA_OUTCOME",
    "وضعیت ثبت همتا معتبر نیست.",
  );
}

/** @param {unknown} outcome */
export function simulateHamta(outcome) {
  if (outcome !== "activated" && outcome !== "submitted" && outcome !== "error")
    throw new ApiError(
      400,
      "INVALID_HAMTA_OUTCOME",
      "وضعیت شبیه‌سازی معتبر نیست.",
    );
  return {
    mode: "simulation",
    label: "شبیه‌سازی — ثبت واقعی نیست",
    status: outcome,
  };
}

/** @param {Store} store @param {Unit} unit @param {unknown} input @param {ReturnType<typeof hamtaAction>} action @param {string} actorId @param {Session} session */
export async function recordHamta(
  store,
  unit,
  input,
  action,
  actorId,
  session,
) {
  const body = fields(input);
  checkUnitVersion(unit, body.version);
  if (!unit.qcPassedAt || !unit.hamtaStatus)
    throw conflict("فقط گوشی تأییدشده در QC نهایی آمادهٔ ثبت همتا است.");
  if (unit.hamtaStatus === "activated")
    throw conflict("این گوشی در همتا فعال شده و نتیجه قفل است.");
  if (action === "submit" && unit.hamtaStatus !== "pending")
    throw conflict("ثبت قبلی را با تطبیق یا ثبت تلاش مجدد پیگیری کنید.");
  if (action !== "submit" && unit.hamtaStatus === "pending")
    throw conflict("برای این گوشی هنوز نتیجهٔ اولیه ثبت نشده است.");

  const result = manualResult(body);
  if (action === "retry" && result.hamtaStatus === "activated")
    throw conflict("موفقیت را فقط با ثبت نتیجهٔ واقعی در تطبیق وارد کنید.");
  const at = new Date();
  const data = { ...result, hamtaActorId: actorId, hamtaAt: at };
  /** @type {Record<string,true>} */
  const unset =
    result.hamtaStatus === "activated"
      ? { hamtaReason: true }
      : { trackingCode: true, hamtaEvidence: true };
  const row = await store.units.findOneAndUpdate(
    { _id: unit._id, version: unit.version },
    { $set: data, $unset: unset, $inc: { version: 1 } },
    { session, returnDocument: "after" },
  );
  if (!row) throw conflict("نسخهٔ گوشی تغییر کرده است.");
  await store.pairs.updateOne(
    { _id: new ObjectId(unit.pairId) },
    { $set: { hamtaStatus: result.hamtaStatus } },
    { session },
  );
  await history(
    store,
    String(unit._id),
    "hamta." + action,
    actorId,
    unit.scope,
    data,
    session,
  );
  return publicRow(row);
}

/** @param {Store} store @param {Unit} unit @param {unknown} input @param {string} actorId @param {Session} session */
export async function recordImeiError(store, unit, input, actorId, session) {
  const body = fields(input);
  checkUnitVersion(unit, body.version);
  if (unit.hamtaStatus) throw conflict("خطای گوشی را در بخش همتا پیگیری کنید.");
  const imeiError = text(body.reason, 500);
  const row = await store.units.findOneAndUpdate(
    { _id: unit._id, version: unit.version },
    { $set: { imeiError }, $inc: { version: 1 } },
    { session, returnDocument: "after" },
  );
  if (!row) throw conflict("نسخهٔ گوشی تغییر کرده است.");
  await store.pairs.updateOne(
    { _id: new ObjectId(unit.pairId) },
    { $set: { hasError: true } },
    { session },
  );
  await history(
    store,
    String(unit._id),
    "unit.error",
    actorId,
    unit.scope,
    { reason: imeiError },
    session,
  );
  return publicRow(row);
}
