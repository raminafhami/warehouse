import { ObjectId } from "mongodb";
import {
  configuration,
  conflict,
  latestResults,
  missing,
  routing,
} from "../assembly/workflow.js";
import { lockUnit, requireConfirmed, scanCode } from "../basket/workflow.js";
import { requirePermission } from "../identity/permissions.js";
import {
  badInput,
  objectId,
  text,
  versionInput,
} from "../identity/validation.js";
import { minor } from "../inventory/amounts.js";
import { recordMilestone } from "../imei/orders.js";
import { publicRow } from "../imei/store.js";

/** @typedef {import("../assembly/store.js").Store} Store */
/** @typedef {import("../identity/commands.js").Actor} Actor */
/** @typedef {import("mongodb").ClientSession} Session */

export const checks = {
  appearance: "سلامت بدنه و ظاهر",
  power: "روشن‌شدن و عملکرد پایه",
  display: "نمایشگر و کلیدها",
  audio: "صدا و میکروفون",
  network: "سیم‌کارت و ارتباط",
};
export const packing = [
  "سلامت جعبه",
  "تطابق مدل و رنگ جعبه",
  "تکمیل اقلام داخل جعبه",
];

/** @param {Store} store @param {unknown} id @param {Session} [session] */
export async function loadQuality(store, id, session) {
  const unit = await store.imei.units.findOne(
    { _id: objectId(id), state: "allocated" },
    { session },
  );
  if (!unit?.basketId) throw missing();
  const basket = await store.baskets.findOne(
    {
      _id: objectId(unit.basketId),
      status: "received",
      unitId: String(unit._id),
    },
    { session },
  );
  if (!basket) throw missing();
  const steps = await routing(store, basket, session);
  const position = await store.positions.findOne(
    { _id: unit._id },
    { session },
  );
  const record = await store.final.findOne({ _id: unit._id }, { session });
  if (
    !position ||
    (position.next !== steps.length && record?.status !== "rework")
  )
    throw conflict("گوشی هنوز به کنترل کیفیت نهایی نرسیده است.");
  return { unit, basket, steps, position, record };
}

/** @param {Store} store @param {Awaited<ReturnType<typeof loadQuality>>} data @param {Session} session */
async function prerequisites(store, { unit, basket, steps }, session) {
  const id = String(unit._id);
  const visits = await store.visits
    .find(
      {
        unitId: id,
        status: "transferred",
        routingVersionId: basket.routingVersionId,
      },
      { session },
    )
    .sort({ entryAt: -1, _id: -1 })
    .toArray();
  for (const [index, step] of steps.entries()) {
    const visit = visits.find((row) => (row.routeIndex ?? row.index) === index);
    if (!visit) throw conflict("مراحل اجباری مونتاژ کامل نیست.");
    const results = latestResults(
      await store.results
        .find({ visitId: String(visit._id) }, { session })
        .toArray(),
    );
    if (step.testIds.some((testId) => results.get(testId)?.outcome !== "pass"))
      throw conflict("تست اجباری ایستگاه قبول نشده است.");
  }
  if (
    await store.defects.findOne(
      {
        visitId: { $in: visits.map((row) => String(row._id)) },
        status: { $nin: ["resolved", "retest_failed"] },
      },
      { session },
    )
  )
    throw conflict("پروندهٔ خرابی باز است.");
  const installed = await store.parts
    .find({ unitId: id, state: "installed" }, { session })
    .toArray();
  for (const need of basket.needs) {
    if (
      installed
        .filter(
          (part) =>
            part.skuId === need.skuId && part.stationCode === need.stationCode,
        )
        .reduce((sum, part) => sum + minor(part.quantity.toString()), 0n) !==
      minor(need.quantity)
    )
      throw conflict("قطعات نصب‌شده با BOM مصوب سازگار نیستند.");
  }
}

/** @param {Store} store @param {Awaited<ReturnType<typeof loadQuality>>} data @param {Actor} actor */
export async function qualityDetail(store, data, actor) {
  requirePermission(actor.grant, "finalQc:view", data.unit.scope);
  const unitId = String(data.unit._id);
  const [results, rejections] = await Promise.all([
    store.finalChecks.find({ unitId }).sort({ round: -1, at: 1 }).toArray(),
    store.finalRejections.find({ unitId }).sort({ round: -1 }).toArray(),
  ]);
  return {
    unit: {
      id: unitId,
      code: data.unit.code,
      numbers: data.unit.numbers,
      modelName: data.unit.modelName,
      lineName: data.unit.lineName,
      colorName: data.basket.colorName,
    },
    record: data.record ? publicRow(data.record) : null,
    checks,
    packing,
    steps: data.steps.map((step) => ({
      id: step.stationId,
      name: configuration(step).name,
    })),
    results: results.map(publicRow),
    rejections: rejections.map(publicRow),
  };
}

export const qualityActions = {
  check: "finalQc:create",
  reject: "finalQc:reject",
  approve: "finalQc:approve",
  label: "finalQc:create",
  pack: "finalQc:approve",
};

/** @param {Store} store @param {Awaited<ReturnType<typeof loadQuality>>} data @param {keyof typeof qualityActions} action @param {Actor} actor @param {Record<string,unknown>} body @param {Session} session */
export async function changeQuality(store, data, action, actor, body, session) {
  const { unit, basket, steps, position, record } = data;
  requirePermission(actor.grant, qualityActions[action], unit.scope);
  if (versionInput(body.version) !== (record?.version ?? 0))
    throw conflict("نسخهٔ پرونده تغییر کرده است.");
  requireConfirmed(basket, unit);
  const actorId = String(actor.user._id),
    unitId = String(unit._id),
    at = new Date();
  const round = record?.round ?? 1,
    status = record?.status ?? "testing";
  /** @type {Partial<import("./store.js").FinalRecord>} */
  const patch = {};
  if (action === "label" || action === "pack") {
    if (status !== "passed" && !(action === "label" && status === "packed"))
      throw conflict("گوشی باید ابتدا در کیفیت نهایی تأیید شود.");
    if (!unit.qcPassedAt)
      throw conflict("تأیید کیفیت نهایی در پروندهٔ گوشی ثبت نشده است.");
    if (action === "label" && record?.labelPairId === unit.pairId)
      return record;
    await lockUnit(store, unit, session);
    if (action === "label")
      Object.assign(patch, {
        labelPairId: unit.pairId,
        labelAt: at,
        labelBy: actorId,
      });
    else {
      if (record?.labelPairId !== unit.pairId)
        throw conflict("ابتدا برچسب جعبه را صادر کنید.");
      if (
        !Array.isArray(body.scans) ||
        body.scans.length !== unit.numbers.length ||
        unit.numbers.some(
          (number, index) =>
            number !==
            scanCode(text(/** @type {unknown[]} */ (body.scans)[index], 40)),
        )
      )
        throw conflict("اسکن هر جایگاه باید با IMEI همان جایگاه یکی باشد.");
      if (
        !Array.isArray(body.checklist) ||
        body.checklist.length !== packing.length ||
        body.checklist.some((answer) => answer !== true)
      )
        throw conflict("همهٔ موارد بسته‌بندی باید تأیید شوند.");
      Object.assign(patch, {
        status: "packed",
        packedBy: actorId,
        packedAt: at,
      });
    }
  } else {
    if (
      status !== "testing" ||
      position.visitId ||
      position.next !== steps.length
    )
      throw conflict("گوشی در صف کنترل کیفیت نهایی نیست.");
    if (action !== "approve") await lockUnit(store, unit, session);
    const results = await store.finalChecks
      .find({ unitId, round }, { session })
      .toArray();
    if (action === "check") {
      const item = text(body.item, 30),
        outcome = body.outcome;
      if (
        !Object.hasOwn(checks, item) ||
        (outcome !== "pass" && outcome !== "fail")
      )
        throw badInput();
      if (results.some((row) => row.item === item))
        throw conflict("این آزمون برای تلاش جاری ثبت شده است.");
      await store.finalChecks.insertOne(
        { _id: new ObjectId(), unitId, round, item, outcome, at, actorId },
        { session },
      );
    } else if (action === "reject") {
      if (!results.some((row) => row.outcome === "fail"))
        throw conflict("ابتدا نتیجهٔ مردود ثبت کنید.");
      const stationId = String(objectId(body.stationId)),
        next = steps.findIndex((step) => step.stationId === stationId);
      if (next < 0)
        throw conflict("ایستگاه اصلاح باید در مسیر همین گوشی باشد.");
      await store.finalRejections.insertOne(
        {
          _id: new ObjectId(),
          unitId,
          round,
          stationId,
          reason: text(body.reason, 500),
          at,
          actorId,
        },
        { session },
      );
      await store.positions.updateOne(
        { _id: unit._id },
        { $set: { next, reworkRound: round } },
        { session },
      );
      Object.assign(patch, { status: "rework", round: round + 1 });
    } else {
      if (
        Object.keys(checks).some(
          (item) =>
            !results.some((row) => row.item === item && row.outcome === "pass"),
        )
      )
        throw conflict("تمام آزمون‌های نهایی باید قبول باشند.");
      if (!unit.numbers.includes(scanCode(text(body.code, 40))))
        throw conflict("IMEI اسکن‌شده به این گوشی تعلق ندارد.");
      await prerequisites(store, data, session);
      await recordMilestone(store.imei, unit, "final-qc", actorId, session);
      patch.status = "passed";
    }
  }
  if (!record) {
    const row = { _id: unit._id, round, status, version: 1, ...patch };
    await store.final.insertOne(row, { session });
    return row;
  }
  const next = await store.final.findOneAndUpdate(
    { _id: unit._id, version: record.version },
    { $set: patch, $inc: { version: 1 } },
    { session, returnDocument: "after" },
  );
  if (!next) throw conflict("نسخهٔ پرونده تغییر کرده است.");
  return next;
}
