import { ObjectId } from "mongodb";
import { conflict, missing } from "../assembly/workflow.js";
import { lockUnit, scanCode } from "../basket/workflow.js";
import {
  activeReference,
  checkLocationCompatibility,
} from "../catalog/records.js";
import { nextCode } from "../handover/requests.js";
import { requirePermission } from "../identity/permissions.js";
import { objectId, text, versionInput } from "../identity/validation.js";

/** @typedef {import("../assembly/store.js").Store} Store */
/** @typedef {import("./store.js").Carton} Carton */
/** @typedef {import("../identity/commands.js").Actor} Actor */
/** @typedef {import("mongodb").ClientSession} Session */
/** @typedef {Record<string,unknown>} Body */

export const capacity = 9;

/** @param {Store} store @param {Actor} actor @param {Body} body @param {Session} session */
export async function createCarton(store, actor, body, session) {
  const warehouse = await activeReference(
    store.catalog,
    "warehouses",
    String(objectId(body.warehouseId)),
    session,
  );
  requirePermission(actor.grant, "finished:create", warehouse.scope);
  if (warehouse.data.purpose !== "finished")
    throw conflict("انبار محصول را انتخاب کنید.");
  const model = await activeReference(
    store.catalog,
    "models",
    String(objectId(body.modelId)),
    session,
  );
  const color = await activeReference(
    store.catalog,
    "colors",
    String(objectId(body.colorId)),
    session,
  );
  if (
    !(/** @type {string[]} */ (model.data.colorIds).includes(String(color._id)))
  )
    throw conflict("این رنگ برای مدل انتخاب‌شده فعال نیست.");
  /** @type {Carton} */
  const carton = {
    _id: new ObjectId(),
    code: await nextCode(store, "finished-carton", "MC", session),
    scope: warehouse.scope,
    modelId: String(model._id),
    colorId: String(color._id),
    modelName: model.name,
    colorName: color.name,
    capacity,
    status: "open",
    version: 1,
    members: [],
    at: new Date(),
  };
  await store.finishedCartons.insertOne(carton, { session });
  return carton;
}

/** @param {Store} store @param {unknown} id @param {Session} [session] */
export async function loadCarton(store, id, session) {
  const carton = await store.finishedCartons.findOne(
    { _id: objectId(id) },
    { session },
  );
  if (!carton) throw missing();
  return carton;
}

export const cartonActions = {
  scan: "finished:scan",
  remove: "finished:edit",
  label: "finished:create",
  close: "finished:approve",
  place: "finished:transfer",
};

/** @param {Store} store @param {Carton} carton @param {keyof typeof cartonActions} action @param {Actor} actor @param {Body} body @param {Session} session */
export async function changeCarton(
  store,
  carton,
  action,
  actor,
  body,
  session,
) {
  requirePermission(actor.grant, cartonActions[action], carton.scope);
  if (versionInput(body.version) !== carton.version)
    throw conflict("نسخهٔ کارتن تغییر کرده است.");
  const at = new Date();
  /** @type {Partial<Carton>} */
  const patch = {};
  /** @type {import("mongodb").UpdateFilter<Carton>} */
  const change = { $set: patch, $inc: { version: 1 } };
  if (action === "place") {
    if (carton.status === "open") throw conflict("ابتدا کارتن را ببندید.");
    const location = await activeReference(
      store.catalog,
      "locations",
      String(objectId(body.locationId)),
      session,
    );
    requirePermission(actor.grant, "finished:transfer", location.scope);
    if (
      location.scope.warehouseId !== carton.scope.warehouseId ||
      scanCode(text(body.code, 80)) !== scanCode(location.code)
    )
      throw conflict(
        "بارکد و موقعیت باید به انبار همین کارتن تعلق داشته باشند.",
      );
    if (carton.locationId === String(location._id))
      throw conflict("کارتن از قبل در همین موقعیت قرار دارد.");
    checkLocationCompatibility(location, { modelId: carton.modelId });
    Object.assign(patch, {
      status: "placed",
      locationId: String(location._id),
      locationName: location.name,
      placedAt: at,
    });
  } else {
    if (carton.status !== "open")
      throw conflict("این عملیات فقط روی کارتن باز ممکن است.");
    if (action === "scan" || action === "remove") {
      const add = action === "scan";
      if (add && carton.members.length >= carton.capacity)
        throw conflict("کارتن پر است.");
      const unit = await store.imei.units.findOne(
        add
          ? { numbers: scanCode(text(body.code, 40)), state: "allocated" }
          : { _id: objectId(body.unitId), state: "allocated" },
        { session },
      );
      if (
        !unit?.qcPassedAt ||
        unit.scope.branchId !== carton.scope.branchId ||
        unit.imeiError
      )
        throw conflict("گوشی بسته‌بندی‌شدهٔ معتبر در شعبه پیدا نشد.");
      const record = await store.final.findOne(
        { _id: unit._id, status: "packed", labelPairId: unit.pairId },
        { session },
      );
      if (!record)
        throw conflict("بسته‌بندی و تطبیق برچسب این گوشی تأیید نشده است.");
      const member = carton.members.find(
        (row) => row.unitId === String(unit._id),
      );
      if (add && (record.cartonId || member))
        throw conflict("این گوشی از قبل در یک کارتن ثبت شده است.");
      await lockUnit(store, unit, session);
      if (add) {
        const order = await store.imei.orders.findOne(
          { _id: objectId(unit.orderId) },
          { session },
        );
        if (
          !order ||
          order.modelId !== carton.modelId ||
          order.colorId !== carton.colorId
        )
          throw conflict("مدل و رنگ گوشی باید با کارتن یکسان باشد.");
        patch.members = [
          ...carton.members,
          {
            unitId: String(unit._id),
            unitCode: unit.code,
            numbers: unit.numbers,
          },
        ];
        await store.final.updateOne(
          { _id: unit._id },
          { $set: { cartonId: String(carton._id) }, $inc: { version: 1 } },
          { session },
        );
      } else {
        if (record.cartonId !== String(carton._id) || !member)
          throw conflict("این گوشی عضو این کارتن نیست.");
        patch.members = carton.members.filter(
          (row) => row.unitId !== String(unit._id),
        );
        await store.final.updateOne(
          { _id: unit._id },
          { $unset: { cartonId: "" }, $inc: { version: 1 } },
          { session },
        );
      }
      change.$unset = { labelAt: "", labelVersion: "" };
    } else {
      if (carton.members.length !== carton.capacity)
        throw conflict("کارتن باید دقیقاً ۹ گوشی داشته باشد.");
      if (action === "label") {
        if (carton.labelVersion === carton.version) return carton;
        Object.assign(patch, { labelVersion: carton.version + 1, labelAt: at });
      } else {
        if (carton.labelVersion !== carton.version)
          throw conflict("برای ترکیب فعلی، برچسب کارتن را صادر کنید.");
        if (scanCode(text(body.code, 40)) !== carton.code)
          throw conflict("بارکد کارتن اشتباه است.");
        Object.assign(patch, { status: "closed", closedAt: at });
      }
    }
  }
  const updated = await store.finishedCartons.findOneAndUpdate(
    { _id: carton._id, version: carton.version },
    change,
    { session, returnDocument: "after" },
  );
  if (!updated) throw conflict("نسخهٔ کارتن تغییر کرده است.");
  return updated;
}
