import { ObjectId } from "mongodb";
import {
  lockUnit,
  requireConfirmed,
  scanCode,
  unitForBasket,
} from "../basket/workflow.js";
import { publicPart } from "../basket/parts.js";
import { ApiError } from "../http-error.js";
import { hasPermission, requirePermission } from "../identity/permissions.js";
import {
  badInput,
  objectId,
  text,
  versionInput,
} from "../identity/validation.js";
import { publicRow } from "../imei/store.js";
import { scopeQuery } from "../inventory/queries.js";
import { decimal, minor } from "../inventory/amounts.js";

/** @typedef {import("./store.js").Store} Store */
/** @typedef {import("./store.js").Visit} Visit */
/** @typedef {import("./store.js").Result} Result */
/** @typedef {import("../identity/commands.js").Actor} Actor */
/** @typedef {import("mongodb").ClientSession} Session */
/** @typedef {import("../basket/store.js").Basket} Basket */
/** @typedef {import("../catalog/store.js").RouteStep} Step */

export const missing = () =>
  new ApiError(404, "ASSEMBLY_NOT_FOUND", "گوشی، ایستگاه یا برچسب پیدا نشد.");
/** @param {string} message */
export const conflict = (message) =>
  new ApiError(409, "ASSEMBLY_CONFLICT", message);

/** @param {Step} step */
export function configuration(step) {
  const {
    requirements,
    allowedRoleIds,
    maxRetests,
    supervisorApproval,
    stationName,
    operation,
    tests,
  } = step.configuration;
  const definitions =
    /** @type {{code:string,name:string,results:string[]}[]|undefined} */ (
      tests
    );
  return {
    name: String(stationName ?? step.stationCode),
    operation: String(operation ?? ""),
    requirements: /** @type {string[]} */ (requirements ?? []),
    allowedRoleIds: /** @type {string[]} */ (allowedRoleIds ?? []),
    supervisorApproval: supervisorApproval === true,
    maxRetests: Number(maxRetests ?? 0),
    tests: step.testIds.map((id, index) => {
      const definition = definitions?.[index];
      if (!definition) throw conflict("تعریف تست در نسخه مسیر کامل نیست.");
      return { ...definition, id };
    }),
  };
}

/** @param {Store} store @param {Basket} basket @param {Session} [session] */
export async function routing(store, basket, session) {
  const version = await store.catalog.versions.findOne(
    {
      _id: objectId(basket.routingVersionId),
      type: "routing",
      modelId: basket.modelId,
      lineId: basket.lineId,
    },
    { session },
  );
  if (!version?.steps?.length)
    throw conflict("نسخهٔ مسیر تولید گوشی در دسترس نیست.");
  const stationCodes = new Set(version.steps.map((step) => step.stationCode));
  if (basket.needs.some((need) => !stationCodes.has(need.stationCode)))
    throw conflict("مسیر تولید همهٔ ایستگاه‌های BOM را پوشش نمی‌دهد.");
  return version.steps;
}

/** @param {Actor} actor @param {Step} step */
function requireOperator(actor, step) {
  const { allowedRoleIds } = configuration(step);
  if (allowedRoleIds.length && !allowedRoleIds.includes(actor.user.roleId))
    throw new ApiError(
      403,
      "FORBIDDEN",
      "نقش شما برای عملیات این ایستگاه مجاز نیست.",
    );
}

/** @param {Store} store @param {Actor} actor @param {Record<string,unknown>} body @param {Session} session */
export async function enter(store, actor, body, session) {
  const stationId = String(objectId(body.stationId));
  const modelId = String(objectId(body.modelId));
  const code = scanCode(text(body.code, 80));
  const station = await store.catalog.records.findOne(
    { _id: objectId(stationId), kind: "stations" },
    { session },
  );
  if (!station) throw missing();
  requirePermission(actor.grant, "assembly:scan", station.scope);
  const unit = await store.imei.units.findOne(
    { $or: [{ code }, { numbers: code }], state: "allocated" },
    { session },
  );
  if (!unit?.basketId) throw missing();
  const basket = await store.baskets.findOne(
    { _id: objectId(unit.basketId), unitId: String(unit._id) },
    { session },
  );
  if (!basket || basket.lineId !== station.scope.lineId)
    throw conflict("این گوشی در صف خط انتخاب‌شده نیست.");
  const scope = { ...basket.scope, stationId };
  requirePermission(actor.grant, "assembly:scan", scope);
  if (basket.modelId !== modelId)
    throw conflict("این گوشی مربوط به مدل انتخاب‌شده نیست.");
  if (basket.status !== "received")
    throw conflict("ابتدا دریافت سبد در مونتاژ را تأیید کنید.");
  requireConfirmed(basket, unit);
  const steps = await routing(store, basket, session);
  const position = await store.positions.findOne(
    { _id: unit._id },
    { session },
  );
  const index = position?.next ?? 0;
  const step = steps[index];
  if (!step)
    throw conflict("مونتاژ گوشی تکمیل شده و در انتظار کنترل کیفیت نهایی است.");
  if (step.stationId !== stationId)
    throw conflict("ایستگاه بعدی گوشی «" + configuration(step).name + "» است.");
  requireOperator(actor, step);
  if (position?.visitId) {
    const active = await store.visits.findOne(
      { _id: position.visitId },
      { session },
    );
    if (active?.enteredBy === String(actor.user._id)) return active;
    throw conflict("گوشی هم‌اکنون در اختیار اپراتور دیگری است.");
  }
  /** @type {Visit} */
  const visit = {
    _id: new ObjectId(),
    unitId: String(unit._id),
    unitCode: unit.code,
    basketId: String(basket._id),
    scope,
    modelName: basket.modelName,
    lineName: basket.lineName,
    stationCode: step.stationCode,
    stationName: configuration(step).name,
    index: position?.reworkRound ? -position.reworkRound : index,
    ...(position?.reworkRound ? { routeIndex: index } : {}),
    routingVersionId: basket.routingVersionId,
    status: "installing",
    version: 1,
    entryAt: new Date(),
    enteredBy: String(actor.user._id),
    enteredName: actor.user.name,
  };
  await lockUnit(store, unit, session);
  if (position)
    await store.positions.updateOne(
      { _id: unit._id },
      { $set: { visitId: visit._id } },
      { session },
    );
  else
    await store.positions.insertOne(
      { _id: unit._id, next: 0, visitId: visit._id },
      { session },
    );
  await store.visits.insertOne(visit, { session });
  return visit;
}

/** @param {Store} store @param {unknown} id @param {Session} [session] */
export async function loadVisit(store, id, session) {
  const visit = await store.visits.findOne({ _id: objectId(id) }, { session });
  if (!visit) throw missing();
  return visit;
}

/** @param {Store} store @param {Visit} visit @param {Session} [session] */
export async function context(store, visit, session) {
  const basket = await store.baskets.findOne(
    { _id: objectId(visit.basketId) },
    { session },
  );
  if (!basket) throw missing();
  const steps = await routing(store, basket, session);
  const step = steps[visit.routeIndex ?? visit.index];
  if (!step || step.stationId !== visit.scope.stationId) throw missing();
  return { basket, step, steps, settings: configuration(step) };
}

/** @param {Store} store @param {Visit} visit @param {Partial<Visit>} patch @param {Session} session */
async function update(store, visit, patch, session) {
  const next = await store.visits.findOneAndUpdate(
    { _id: visit._id, version: visit.version },
    { $set: patch, $inc: { version: 1 } },
    { session, returnDocument: "after" },
  );
  if (!next) throw conflict("ایستگاه تغییر کرده است. دوباره بارگیری کنید.");
  return next;
}

/** @param {Result[]} rows */
export function latestResults(rows) {
  const current = new Map();
  for (const row of rows) {
    const prior = current.get(row.testId);
    if (
      !prior ||
      row.attempt > prior.attempt ||
      (row.attempt === prior.attempt && row.revision > prior.revision)
    )
      current.set(row.testId, row);
  }
  return current;
}

/** @param {Store} store @param {Visit} visit @param {Step} step @param {Actor} actor @param {Record<string,unknown>} body @param {Session} session */
async function install(store, visit, step, actor, body, session) {
  const part = await store.parts.findOne(
    {
      code: scanCode(text(body.code, 80)),
      basketId: visit.basketId,
      unitId: visit.unitId,
    },
    { session },
  );
  if (!part) throw missing();
  if (part.stationCode !== step.stationCode)
    throw conflict("برچسب متعلق به این ایستگاه نیست.");
  if (part.state !== "allocated")
    throw conflict("برچسب قبلاً نصب شده یا آمادهٔ نصب نیست.");
  const source = await store.custody.findOne(
    {
      _id: objectId(part.custodyId),
      cartonId: part.cartonId,
      lineId: part.lineId,
      skuId: part.skuId,
    },
    { session },
  );
  const amount = minor(part.quantity.toString());
  const available = minor(source?.basket?.toString() ?? "0");
  if (!source || available < amount)
    throw conflict("ماندهٔ قطعه در سبد کافی نیست.");
  const at = new Date();
  const actorId = String(actor.user._id);
  await store.custody.updateOne(
    { _id: source._id },
    {
      $set: {
        basket: decimal(available - amount),
        consumed: decimal(minor(source.consumed?.toString() ?? "0") + amount),
      },
    },
    { session },
  );
  await store.parts.updateOne(
    { _id: part._id },
    {
      $set: {
        state: "installed",
        installedAt: at,
        installedBy: actorId,
        visitId: String(visit._id),
      },
    },
    { session },
  );
  const documentId = new ObjectId().toHexString();
  await store.ledger.insertOne(
    {
      _id: documentId,
      documentId,
      documentType: "assembly.part.install",
      skuId: part.skuId,
      cartonId: part.cartonId,
      warehouseId: part.warehouseId,
      scope: visit.scope,
      fromScope: part.scope,
      lineId: part.lineId,
      basketId: part.basketId,
      partId: String(part._id),
      unitId: visit.unitId,
      from: "basket",
      to: "consumed",
      quantity: part.quantity,
      actorId,
      at,
    },
    { session },
  );
  return String(part._id);
}

/** @param {Store} store @param {Visit} visit @param {Basket} basket @param {Step} step @param {Record<string,unknown>} body @param {Session} session */
async function checkCompletion(store, visit, basket, step, body, session) {
  const unit = await unitForBasket(store, basket, session);
  requireConfirmed(basket, unit);
  const code = scanCode(text(body.code, 80));
  if (code !== unit.code && !unit.numbers.includes(code))
    throw conflict("شناسه همین گوشی را دوباره اسکن کنید.");
  const parts = await store.parts
    .find(
      {
        basketId: visit.basketId,
        stationCode: visit.stationCode,
        state: "installed",
      },
      { session },
    )
    .toArray();
  const needs = basket.needs.filter(
    (need) => need.stationCode === step.stationCode,
  );
  for (const need of needs) {
    const quantity = parts
      .filter((part) => part.skuId === need.skuId)
      .reduce((sum, part) => sum + minor(part.quantity.toString()), 0n);
    if (quantity !== minor(need.quantity))
      throw conflict(
        "نصب قطعه «" + need.skuCode + "» در این مرحله کامل نشده است.",
      );
  }
  const answers = body.checklist;
  if (
    !Array.isArray(answers) ||
    answers.length !== configuration(step).requirements.length ||
    answers.some((answer) => answer !== true)
  )
    throw conflict("همهٔ پرسش‌های چک‌لیست باید تأیید شوند.");
  return /** @type {boolean[]} */ (answers);
}

/** @param {Store} store @param {Visit} visit @param {ReturnType<typeof configuration>} settings @param {Actor} actor @param {Record<string,unknown>} body @param {Session} session */
async function recordResult(store, visit, settings, actor, body, session) {
  const test = settings.tests.find(
    (definition) => definition.id === body.testId,
  );
  const answer = text(body.answer, 60);
  const outcome = body.outcome;
  if (
    !test?.results.includes(answer) ||
    (outcome !== "pass" && outcome !== "fail" && outcome !== "review")
  )
    throw badInput();
  const prior = await store.results.findOne(
    { visitId: String(visit._id), testId: test.id },
    { session, sort: { attempt: -1, revision: -1 } },
  );
  const correctiveCase = await store.defects.findOne(
    { visitId: String(visit._id), testId: test.id },
    { session, sort: { at: -1, _id: -1 } },
  );
  const correcting = body.replacesId !== undefined;
  if (
    correctiveCase &&
    correctiveCase.status !== "resolved" &&
    (correctiveCase.status !== "retest" || correcting)
  )
    throw conflict("ابتدا اقدام اصلاحی پرونده را تکمیل کنید.");
  let reason;
  if (correcting) {
    requirePermission(actor.grant, "stageQc:edit", visit.scope);
    if (!prior || String(prior._id) !== String(objectId(body.replacesId)))
      throw conflict("فقط آخرین نتیجهٔ همان تست قابل اصلاح است.");
    reason = text(body.reason, 500);
  } else if (
    prior &&
    (prior.outcome === "pass" ||
      (!correctiveCase && prior.attempt > settings.maxRetests))
  ) {
    throw conflict("تلاش مجدد برای این تست مجاز نیست.");
  }
  /** @type {Result} */
  const row = {
    _id: new ObjectId(),
    visitId: String(visit._id),
    unitId: visit.unitId,
    unitCode: visit.unitCode,
    modelName: visit.modelName,
    stationName: visit.stationName,
    scope: visit.scope,
    routingVersionId: visit.routingVersionId,
    testId: test.id,
    testCode: test.code,
    testName: test.name,
    answer,
    outcome,
    attempt: correcting && prior ? prior.attempt : (prior?.attempt ?? 0) + 1,
    revision: correcting && prior ? prior.revision + 1 : 1,
    ...(correcting && prior ? { replacesId: String(prior._id), reason } : {}),
    actorId: String(actor.user._id),
    at: new Date(),
  };
  await store.results.insertOne(row, { session });
  if (correctiveCase?.status === "retest")
    await store.defects.updateOne(
      { _id: correctiveCase._id },
      {
        $set: { status: outcome === "pass" ? "resolved" : "retest_failed" },
        $inc: { version: 1 },
        $push: {
          decisions: {
            action: "retest",
            reason: outcome,
            resultId: String(row._id),
            actorId: row.actorId,
            at: row.at,
          },
        },
      },
      { session },
    );
  return row;
}

export const permissions = {
  install: "assembly:scan",
  complete: "assembly:create",
  test: "stageQc:create",
  correct: "stageQc:edit",
  transfer: "assembly:approve",
};
/** @param {Store} store @param {Visit} visit @param {keyof typeof permissions} action @param {Actor} actor @param {Record<string,unknown>} body @param {Session} session */
export async function act(store, visit, action, actor, body, session) {
  requirePermission(actor.grant, permissions[action], visit.scope);
  if (visit.version !== versionInput(body.version))
    throw conflict("ایستگاه تغییر کرده است. دوباره بارگیری کنید.");
  const { basket, step, steps, settings } = await context(
    store,
    visit,
    session,
  );
  const unit = await unitForBasket(store, basket, session);
  requireConfirmed(basket, unit);
  const actorId = String(actor.user._id);
  const position = await store.positions.findOne(
    { _id: unit._id, visitId: visit._id },
    { session },
  );
  if (!position) throw conflict("این مراجعه در ایستگاه فعال نیست.");
  await lockUnit(store, unit, session);
  const at = new Date();
  if (action === "install" || action === "complete") {
    requireOperator(actor, step);
    if (visit.status !== "installing" || visit.enteredBy !== actorId)
      throw conflict("گوشی در وضعیت نصب یا در اختیار شما نیست.");
    if (action === "install") {
      const partId = await install(store, visit, step, actor, body, session);
      return {
        visit: publicRow(await update(store, visit, {}, session)),
        partId,
      };
    }
    const checklist = await checkCompletion(
      store,
      visit,
      basket,
      step,
      body,
      session,
    );
    return {
      visit: publicRow(
        await update(
          store,
          visit,
          {
            status: "testing",
            completedAt: at,
            completedBy: actorId,
            checklist,
          },
          session,
        ),
      ),
    };
  }
  if (visit.status !== "testing")
    throw conflict("گوشی هنوز به کنترل کیفیت مرحله‌ای نرسیده است.");
  if (action === "test" || action === "correct") {
    if ((action === "correct") !== (body.replacesId !== undefined))
      throw badInput();
    const result = await recordResult(
      store,
      visit,
      settings,
      actor,
      body,
      session,
    );
    return {
      visit: publicRow(await update(store, visit, {}, session)),
      result: publicRow(result),
    };
  }
  if (
    settings.supervisorApproval &&
    (visit.enteredBy === actorId ||
      !hasPermission(actor.grant, "stageQc:approve", visit.scope))
  )
    throw new ApiError(
      403,
      "FORBIDDEN",
      "این ایستگاه به تأیید ناظر دیگری با مجوز کنترل کیفیت نیاز دارد.",
    );
  const rows = await store.results
    .find({ visitId: String(visit._id) }, { session })
    .toArray();
  const latest = latestResults(rows);
  if (settings.tests.some((test) => latest.get(test.id)?.outcome !== "pass"))
    throw conflict("همهٔ تست‌های اجباری باید نتیجهٔ قبول داشته باشند.");
  if (
    await store.defects.findOne(
      {
        visitId: String(visit._id),
        status: {
          $in: ["technical", "escalated", "replacing", "rework", "retest"],
        },
      },
      { session },
    )
  )
    throw conflict("ابتدا پرونده‌های باز ایستگاه را تعیین تکلیف کنید.");
  const installed = await store.parts
    .find(
      {
        basketId: visit.basketId,
        stationCode: visit.stationCode,
        state: "installed",
      },
      { session },
    )
    .toArray();
  for (const need of basket.needs.filter(
    (need) => need.stationCode === visit.stationCode,
  )) {
    if (
      installed
        .filter((part) => part.skuId === need.skuId)
        .reduce((sum, part) => sum + minor(part.quantity.toString()), 0n) !==
      minor(need.quantity)
    )
      throw conflict("نصب قطعات ایستگاه کامل نیست.");
  }
  const next = position.reworkRound ? steps.length : visit.index + 1;
  if (position.reworkRound)
    await store.final.updateOne(
      { _id: unit._id, status: "rework" },
      { $set: { status: "testing" }, $inc: { version: 1 } },
      { session },
    );
  await store.positions.updateOne(
    { _id: unit._id },
    { $set: { next }, $unset: { visitId: "", reworkRound: "" } },
    { session },
  );
  return {
    visit: publicRow(
      await update(
        store,
        visit,
        { status: "transferred", exitAt: at, exitedBy: actorId },
        session,
      ),
    ),
    nextStation: steps[next]?.stationCode ?? null,
  };
}

/** @param {Store} store @param {Visit} visit @param {Actor} actor */
export async function detail(store, visit, actor) {
  const can = (/** @type {string} */ permission) =>
    hasPermission(actor.grant, permission, visit.scope);
  if (
    !can("assembly:view") &&
    !can("stageQc:view") &&
    !Object.values(permissions).some(can)
  )
    throw new ApiError(403, "FORBIDDEN", "دسترسی به ایستگاه مجاز نیست.");
  const { basket, step, steps, settings } = await context(store, visit);
  const owned =
    visit.enteredBy === String(actor.user._id) &&
    (!settings.allowedRoleIds.length ||
      settings.allowedRoleIds.includes(actor.user.roleId));
  const [parts, results, defects, history] = await Promise.all([
    store.parts
      .find({
        basketId: visit.basketId,
        stationCode: visit.stationCode,
        state: { $in: ["allocated", "installed"] },
      })
      .sort({ _id: 1 })
      .toArray(),
    store.results
      .find({ visitId: String(visit._id) })
      .sort({ attempt: -1, revision: -1, _id: -1 })
      .toArray(),
    store.defects
      .find({ visitId: String(visit._id) })
      .sort({ at: -1, _id: -1 })
      .toArray(),
    store.visits
      .find({ unitId: visit.unitId, ...scopeQuery(actor.grant) })
      .sort({ entryAt: 1, _id: 1 })
      .toArray(),
  ]);
  return {
    visit: publicRow({ ...visit, index: visit.routeIndex ?? visit.index }),
    routeLength: steps.length,
    history: history.map(publicRow),
    defects: defects.map(publicRow),
    canOpenDefect: can("defects:create"),
    settings: {
      operation: settings.operation,
      requirements: settings.requirements,
      tests: settings.tests,
      maxRetests: settings.maxRetests,
    },
    needs: basket.needs.filter((need) => need.stationCode === step.stationCode),
    parts: parts.map(publicPart),
    results: results.map(publicRow),
    access: {
      install: owned && can(permissions.install),
      complete: owned && can(permissions.complete),
      test: can(permissions.test),
      correct: can(permissions.correct),
      transfer:
        can(permissions.transfer) &&
        (!settings.supervisorApproval ||
          (visit.enteredBy !== String(actor.user._id) &&
            can("stageQc:approve"))),
    },
  };
}
