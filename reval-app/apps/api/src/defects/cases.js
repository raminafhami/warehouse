import { ObjectId } from "mongodb";
import { conflict, context, loadVisit, missing } from "../assembly/workflow.js";
import {
  scanCode,
  lockUnit,
  requireConfirmed,
  unitForBasket,
} from "../basket/workflow.js";
import { publicPart } from "../basket/parts.js";
import { ApiError } from "../http-error.js";
import { nextCode } from "../handover/requests.js";
import { requirePermission } from "../identity/permissions.js";
import {
  badInput,
  objectId,
  text,
  versionInput,
} from "../identity/validation.js";
import { publicRow } from "../imei/store.js";
import { move, replacementStock } from "./movement.js";

/** @typedef {import("../assembly/store.js").Store} Store */
/** @typedef {import("./store.js").Defect} Defect */
/** @typedef {import("../assembly/store.js").Visit} Visit */
/** @typedef {import("../identity/commands.js").Actor} Actor */
/** @typedef {import("mongodb").ClientSession} Session */
/** @typedef {Record<string,unknown>} Body */

/** @param {Store} store @param {Visit} visit @param {Session} session */
async function active(store, visit, session) {
  if (visit.status !== "testing")
    throw conflict("پرونده برای مراجعهٔ فعال در کنترل کیفیت ثبت می‌شود.");
  const info = await context(store, visit, session);
  const unit = await unitForBasket(store, info.basket, session);
  requireConfirmed(info.basket, unit);
  await lockUnit(store, unit, session);
  return { ...info, unit };
}

/** @param {Store} store @param {Visit} visit @param {unknown} id @param {string} actorId @param {string} caseId @param {Session} session */
async function markPart(store, visit, id, actorId, caseId, session) {
  const part = await store.parts.findOne(
    {
      _id: objectId(id),
      basketId: visit.basketId,
      stationCode: visit.stationCode,
      state: "installed",
    },
    { session },
  );
  if (!part) throw conflict("قطعهٔ نصب‌شده در همین ایستگاه را انتخاب کنید.");
  await move(store, part, "consumed", "defective", actorId, caseId, session);
  await store.parts.updateOne(
    { _id: part._id },
    { $set: { state: "defective", defectId: caseId, scope: visit.scope } },
    { session },
  );
  return {
    partId: String(part._id),
    scope: { ...visit.scope, warehouseId: part.warehouseId },
  };
}

/** @param {Store} store @param {Visit} visit @param {boolean} technical @param {Actor} actor @param {Body} body @param {Session} session */
export async function openCase(store, visit, technical, actor, body, session) {
  requirePermission(
    actor.grant,
    technical ? "stageQc:create" : "defects:create",
    visit.scope,
  );
  await active(store, visit, session);
  const result = await store.results.findOne(
    { visitId: String(visit._id), testId: String(objectId(body.testId)) },
    { session, sort: { attempt: -1, revision: -1 } },
  );
  if (
    !result ||
    String(result._id) !== String(objectId(body.resultId)) ||
    result.outcome !== (technical ? "review" : "fail")
  )
    throw conflict(
      technical
        ? "آخرین نتیجهٔ تست باید نیازمند بررسی باشد."
        : "آخرین نتیجهٔ تست باید مردود باشد.",
    );
  if (
    await store.defects.findOne(
      {
        visitId: result.visitId,
        testId: result.testId,
        status: { $nin: ["resolved", "retest_failed"] },
      },
      { session },
    )
  )
    throw conflict("برای این تست پروندهٔ فعال وجود دارد.");
  const id = new ObjectId();
  const actorId = String(actor.user._id);
  /** @type {Defect} */
  const row = {
    _id: id,
    visitId: result.visitId,
    unitCode: visit.unitCode,
    scope: visit.scope,
    testId: result.testId,
    testName: result.testName,
    resultId: String(result._id),
    status: technical ? "technical" : "replacing",
    version: 1,
    reason: text(body.reason, 500),
    at: new Date(),
    actorId,
  };
  if (!technical)
    Object.assign(
      row,
      await markPart(store, visit, body.partId, actorId, String(id), session),
    );
  await store.defects.insertOne(row, { session });
  await store.visits.updateOne(
    { _id: visit._id },
    { $inc: { version: 1 } },
    { session },
  );
  return row;
}

/** @param {Store} store @param {unknown} id @param {Session} [session] */
export async function loadCase(store, id, session) {
  const defect = await store.defects.findOne(
    { _id: objectId(id) },
    { session },
  );
  if (!defect) throw missing();
  return defect;
}

export const caseActions = {
  decide: "stageQc:approve",
  label: "assembly:create",
  install: "assembly:scan",
  rework: "assembly:create",
  cancelLabel: "assembly:create",
};

/** @param {Store} store @param {Defect} defect @param {keyof typeof caseActions} action @param {Actor} actor @param {Body} body @param {Session} session */
export async function updateCase(store, defect, action, actor, body, session) {
  requirePermission(actor.grant, caseActions[action], defect.scope);
  if (versionInput(body.version) !== defect.version)
    throw conflict("نسخهٔ پرونده تغییر کرده است.");
  const visit = await loadVisit(store, defect.visitId, session);
  const { basket, unit, settings } = await active(store, visit, session);
  const actorId = String(actor.user._id);
  const caseId = String(defect._id);
  const at = new Date();
  /** @type {Partial<Defect>} */
  const patch = {};
  /** @type {import("mongodb").UpdateFilter<Defect>} */
  const change = { $set: patch, $inc: { version: 1 } };
  if (action === "decide") {
    if (actorId === defect.actorId || actorId === visit.enteredBy)
      throw new ApiError(
        403,
        "FORBIDDEN",
        "تصمیم فنی باید توسط مسئول مجاز دیگری ثبت شود.",
      );
    if (defect.status !== "technical" && defect.status !== "escalated")
      throw conflict("پرونده در صف تصمیم فنی نیست.");
    const decision = body.decision;
    const reason = text(body.reason, 500);
    if (
      decision !== "replace" &&
      decision !== "rework" &&
      decision !== "escalate"
    )
      throw badInput();
    if (decision === "escalate" && defect.status === "escalated")
      throw conflict("ارجاع بالاتر قبلاً ثبت شده است.");
    patch.status =
      decision === "replace"
        ? "replacing"
        : decision === "rework"
          ? "rework"
          : "escalated";
    if (decision === "replace")
      Object.assign(
        patch,
        await markPart(store, visit, body.partId, actorId, caseId, session),
      );
    change.$push = { decisions: { action: decision, reason, actorId, at } };
  } else {
    if (
      (settings.allowedRoleIds.length &&
        !settings.allowedRoleIds.includes(actor.user.roleId)) ||
      actorId !== visit.enteredBy
    )
      throw conflict("این عملیات باید توسط اپراتور مجاز مراجعه انجام شود.");
    if (action === "rework") {
      if (defect.status !== "rework")
        throw conflict("پرونده در صف دوباره‌کاری نیست.");
      const code = scanCode(text(body.code, 80));
      if (code !== unit.code && !unit.numbers.includes(code))
        throw conflict("شناسهٔ همین گوشی را اسکن کنید.");
      if (
        !Array.isArray(body.checklist) ||
        body.checklist.length !== settings.requirements.length ||
        body.checklist.some((answer) => answer !== true)
      )
        throw conflict("چک‌لیست را کامل تأیید کنید.");
      patch.status = "retest";
      change.$push = {
        decisions: { action, reason: text(body.reason, 500), actorId, at },
      };
    } else if (action === "label") {
      if (
        defect.status !== "replacing" ||
        defect.replacementId ||
        !defect.partId
      )
        throw conflict("پرونده در انتظار رزرو جایگزین نیست.");
      const old = await store.parts.findOne(
        { _id: objectId(defect.partId) },
        { session },
      );
      if (!old) throw missing();
      const source = await replacementStock(
        store,
        basket,
        old,
        body.custodyId,
        session,
      ).next();
      if (!source)
        throw conflict("موجودی کافی از قطعهٔ هم‌مدل در کارتن خط وجود ندارد.");
      /** @type {import("../basket/store.js").Part} */
      const part = {
        _id: new ObjectId(),
        code: await nextCode(store, "basket-part", "PRT", session),
        basketId: old.basketId,
        unitId: old.unitId,
        modelId: old.modelId,
        bomVersionId: old.bomVersionId,
        skuId: old.skuId,
        skuCode: old.skuCode,
        stationCode: old.stationCode,
        custodyId: String(source._id),
        cartonId: source.cartonId,
        cartonCode: source.cartonCode,
        warehouseId: source.warehouseId,
        lineId: old.lineId,
        scope: visit.scope,
        quantity: old.quantity,
        state: "replacement_reserved",
        printedAt: at,
        visitId: defect.visitId,
        defectId: caseId,
        replacesPartId: String(old._id),
      };
      await move(
        store,
        part,
        "line",
        "replacement_reserved",
        actorId,
        caseId,
        session,
      );
      await store.parts.insertOne(part, { session });
      patch.replacementId = String(part._id);
    } else {
      if (defect.status !== "replacing" || !defect.replacementId)
        throw conflict("ابتدا برچسب جایگزین را صادر کنید.");
      const part = await store.parts.findOne(
        { _id: objectId(defect.replacementId), state: "replacement_reserved" },
        { session },
      );
      if (!part) throw missing();
      if (action === "cancelLabel") {
        const reason = text(body.reason, 500);
        await move(
          store,
          part,
          "replacement_reserved",
          "line",
          actorId,
          caseId,
          session,
        );
        await store.parts.updateOne(
          { _id: part._id },
          { $set: { state: "void", closedAt: at, reason } },
          { session },
        );
        change.$unset = { replacementId: "" };
        change.$push = { decisions: { action, reason, actorId, at } };
      } else {
        if (part.code !== scanCode(text(body.code, 80)))
          throw conflict("بارکد با برچسب جایگزین این پرونده مطابقت ندارد.");
        await move(
          store,
          part,
          "replacement_reserved",
          "consumed",
          actorId,
          caseId,
          session,
        );
        await store.parts.updateOne(
          { _id: part._id },
          {
            $set: { state: "installed", installedAt: at, installedBy: actorId },
          },
          { session },
        );
        patch.status = "retest";
      }
    }
  }
  await store.visits.updateOne(
    { _id: visit._id },
    { $inc: { version: 1 } },
    { session },
  );
  const next = await store.defects.findOneAndUpdate(
    { _id: defect._id, version: defect.version },
    change,
    { session, returnDocument: "after" },
  );
  if (!next) throw conflict("نسخهٔ پرونده تغییر کرده است.");
  return next;
}

/** @param {Store} store @param {Defect} defect */
export async function caseDetail(store, defect) {
  const [visit, part, replacement] = await Promise.all([
    loadVisit(store, defect.visitId),
    defect.partId
      ? store.parts.findOne({ _id: objectId(defect.partId) })
      : null,
    defect.replacementId
      ? store.parts.findOne({ _id: objectId(defect.replacementId) })
      : null,
  ]);
  const { basket, settings } = await context(store, visit);
  const stock =
    part && !replacement && defect.status === "replacing"
      ? await replacementStock(store, basket, part).toArray()
      : [];
  return {
    case: publicRow(defect),
    visit: publicRow(visit),
    requirements: settings.requirements,
    part: part ? publicPart(part) : null,
    replacement: replacement ? publicPart(replacement) : null,
    stock: stock.map((row) => ({
      id: String(row._id),
      cartonCode: row.cartonCode,
      line: String(row.line),
    })),
    installed: (
      await store.parts
        .find({
          basketId: visit.basketId,
          stationCode: visit.stationCode,
          state: "installed",
        })
        .toArray()
    ).map(publicPart),
  };
}
