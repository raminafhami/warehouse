import { ObjectId } from "mongodb";
import { ApiError } from "../http-error.js";
import { catalogStore } from "../catalog/store.js";
import { activeReference } from "../catalog/records.js";
import { ids, list } from "../catalog/validation.js";
import {
  fields,
  objectId,
  text,
  versionInput,
} from "../identity/validation.js";
import {
  amountText,
  commandAmount,
  decimal,
  minor,
} from "../inventory/amounts.js";
import { loadBalance, unitFor, writeBalance } from "../inventory/commands.js";
import {
  conflict,
  invalid,
  missing,
  nextCode,
  openVersion,
  updateRequest,
} from "./requests.js";
import { publicDelivery, publicRequest } from "./store.js";

/** @typedef {ReturnType<typeof import("./store.js").handoverStore>} Store */
/** @typedef {import("./store.js").MaterialRequest} MaterialRequest */
/** @typedef {import("./store.js").Delivery} Delivery */
/** @typedef {import("../inventory/store.js").Custody} Custody */
/** @typedef {import("../shipments/store.js").Balance} Balance */
/** @typedef {import("../shipments/store.js").Ledger} Ledger */
/** @typedef {import("mongodb").ClientSession} Session */

/** @param {Store} store @param {ObjectId} id @param {Session} [session] */
export async function loadDelivery(store, id, session) {
  const row = await store.deliveries.findOne({ _id: id }, { session });
  if (!row) throw missing();
  return row;
}
/** @param {Store} store @param {Delivery} row @param {Partial<Delivery>} updated @param {Session} session */
async function updateDelivery(store, row, updated, session) {
  const after = await store.deliveries.findOneAndUpdate(
    { _id: row._id, version: row.version },
    {
      $set: { ...updated, updatedAt: new Date() },
      $inc: { version: 1 },
    },
    { session, returnDocument: "after" },
  );
  if (!after) throw conflict("نسخهٔ حواله تغییر کرده است.");
  return after;
}
/** @param {MaterialRequest} row @param {Map<string,bigint>} changes @returns {{needs:MaterialRequest["needs"],status:MaterialRequest["status"]}} */
function plan(row, changes) {
  const needs = row.needs.map((item) => ({
    ...item,
    issued: amountText(minor(item.issued) + (changes.get(item.skuId) ?? 0n)),
  }));
  if (
    needs.some(
      (item) =>
        minor(item.issued) < 0n || minor(item.issued) > minor(item.required),
    )
  )
    throw conflict("مقدار حواله با ماندهٔ درخواست سازگار نیست.");
  /** @type {MaterialRequest["status"]} */
  const status = needs.every(
    (item) => minor(item.issued) === minor(item.required),
  )
    ? "fulfilled"
    : needs.some((item) => minor(item.issued) > 0n)
      ? "partial"
      : "open";
  return { needs, status: row.status === "cancelled" ? "cancelled" : status };
}
/** @param {Store} store @param {MaterialRequest} row @param {unknown} input @param {string} actorId @param {Session} session */
export async function issueDelivery(store, row, input, actorId, session) {
  const body = fields(input);
  openVersion(row, body.version);
  const requestId = String(row._id);
  const reservationIds = ids(body.reservationIds).map(objectId);
  const reserved = await store.reservations
    .find(
      { _id: { $in: reservationIds }, requestId, state: "active" },
      { session },
    )
    .sort({ _id: 1 })
    .toArray();
  if (reserved.length !== reservationIds.length)
    throw conflict("یک رزرو انتخاب‌شده فعال یا متعلق به درخواست نیست.");
  const catalog = catalogStore(store.database);
  await activeReference(catalog, "warehouses", row.warehouseId, session);
  await activeReference(catalog, "lines", row.lineId, session);
  /** @type {Map<string,bigint>} */
  const issued = new Map();
  for (const selected of reserved)
    issued.set(
      selected.skuId,
      (issued.get(selected.skuId) ?? 0n) + minor(selected.quantity.toString()),
    );
  const updated = await updateRequest(store, row, plan(row, issued), session);
  /** @type {Delivery} */
  const delivery = {
    _id: new ObjectId(),
    code: await nextCode(store, "material-delivery", "DLV", session),
    requestId,
    issuerId: actorId,
    at: new Date(),
    version: 0,
    status: "issued",
  };
  const deliveryId = String(delivery._id);
  for (const selected of reserved) {
    const balance = await loadBalance(store, selected.cartonId, session);
    if (
      balance.account !== "storage" ||
      balance.warehouseId !== row.warehouseId
    )
      throw conflict("موقعیت کارتن رزروشده تغییر کرده است.");
    const amount = minor(selected.quantity.toString());
    const quantity = minor(balance.quantity.toString()) - amount;
    const outstanding = minor(balance.reserved.toString()) - amount;
    if (quantity < 0n || outstanding < 0n || quantity < outstanding)
      throw conflict("مانده یا رزرو برای صدور کافی نیست.");
    const carton = await store.cartons.findOne(
      { _id: objectId(balance.cartonId) },
      { session },
    );
    if (!carton) throw missing();
    await writeBalance(
      store,
      balance,
      { quantity: decimal(quantity), reserved: decimal(outstanding) },
      session,
    );
    await store.reservations.updateOne(
      { _id: selected._id, state: "active" },
      { $set: { state: "consumed" } },
      { session },
    );
    /** @type {Custody} */
    const item = {
      _id: new ObjectId(),
      deliveryId,
      requestId,
      cartonId: balance.cartonId,
      cartonCode: carton.code,
      skuId: balance.skuId,
      skuCode: carton.skuCode,
      warehouseId: balance.warehouseId,
      warehouseScope: row.warehouseScope,
      lineId: row.lineId,
      lineScope: row.lineScope,
      issued: decimal(amount),
      transit: decimal(amount),
      line: decimal(0n),
      returned: decimal(0n),
    };
    await store.custody.insertOne(item, { session });
    await movement(
      store,
      row,
      item,
      balance,
      "handover.issue",
      "storage",
      "transit",
      amount,
      deliveryId,
      actorId,
      null,
      session,
    );
  }
  await store.deliveries.insertOne(delivery, { session });
  return {
    request: publicRequest(updated),
    delivery: publicDelivery(delivery),
  };
}

/**
 * @param {Store} store @param {MaterialRequest} row @param {Custody} item @param {Balance|null} balance
 * @param {Ledger["documentType"]} documentType @param {Ledger["from"]} from @param {Ledger["to"]} to
 * @param {bigint} quantity @param {string} documentId @param {string} actorId @param {string|null} reason @param {Session} session
 */
async function movement(
  store,
  row,
  item,
  balance,
  documentType,
  from,
  to,
  quantity,
  documentId,
  actorId,
  reason,
  session,
) {
  const toWarehouse = to === "storage";
  await store.ledger.insertOne(
    {
      _id: documentId + ":" + String(item._id),
      documentType,
      documentId,
      cartonId: item.cartonId,
      skuId: item.skuId,
      warehouseId: row.warehouseId,
      scope: toWarehouse ? row.warehouseScope : row.lineScope,
      fromScope: from === "storage" ? row.warehouseScope : row.lineScope,
      lineId: row.lineId,
      fromLocationId: from === "storage" ? balance?.locationId : null,
      fromLocationCode: from === "storage" ? balance?.locationCode : null,
      toLocationId: toWarehouse ? balance?.locationId : null,
      toLocationCode: toWarehouse ? balance?.locationCode : null,
      from,
      to,
      quantity: decimal(quantity),
      actorId,
      at: new Date(),
      ...(reason ? { reason } : {}),
    },
    { session },
  );
}

/** @param {Store} store @param {Delivery} delivery @param {unknown} input @param {Session} session */
async function snapshot(store, delivery, input, session) {
  const body = fields(input);
  if (delivery.version !== versionInput(body.version))
    throw conflict("نسخهٔ حواله تغییر کرده است. دوباره بارگیری کنید.");
  const items = await store.custody
    .find({ deliveryId: String(delivery._id) }, { session })
    .sort({ _id: 1 })
    .toArray();
  if (!items.length) throw missing();
  return { body, items };
}
/** @param {Store} store @param {Custody[]} items @param {unknown} input @param {"transit"|"line"} source @param {Session} session */
async function amounts(store, items, input, source, session) {
  /** @type {Map<string,bigint>} */
  const result = new Map();
  const catalog = catalogStore(store.database);
  const byId = new Map(items.map((item) => [String(item._id), item]));
  for (const value of list(input, true)) {
    const body = fields(value);
    const id = String(objectId(body.itemId));
    const item = byId.get(id);
    if (!item || result.has(id))
      throw invalid("ردیف حواله تکراری یا نامعتبر است.");
    const balance = await loadBalance(store, item.cartonId, session);
    const amount = commandAmount(
      body.quantity,
      await unitFor(catalog, balance, session),
    );
    if (amount > minor(item[source].toString()))
      throw conflict("مقدار واردشده بیشتر از ماندهٔ این ردیف حواله است.");
    result.set(id, amount);
  }
  return result;
}

/** @param {Store} store @param {MaterialRequest} row @param {Delivery} delivery @param {unknown} input @param {string} actorId @param {Session} session @param {(action:string)=>void} authorize */
export async function receiveDelivery(
  store,
  row,
  delivery,
  input,
  actorId,
  session,
  authorize,
) {
  if (delivery.issuerId === actorId)
    throw new ApiError(
      403,
      "ISSUER_CANNOT_RECEIVE",
      "صادرکننده نمی‌تواند دریافت همین حواله را تأیید کند.",
    );
  if (delivery.status === "received" || delivery.status === "returned")
    throw conflict("این حواله در انتظار دریافت نیست.");
  const { body, items } = await snapshot(store, delivery, input, session);
  const received = await amounts(store, items, body.items, "transit", session);
  const totalReceived = [...received.values()].reduce(
    (sum, value) => sum + value,
    0n,
  );
  const remaining =
    items.reduce((sum, item) => sum + minor(item.transit.toString()), 0n) -
    totalReceived;
  if (totalReceived > 0n) authorize("approve");
  if (remaining > 0n) authorize("reject");
  const reason = text(body.reason, 500, remaining === 0n);
  const hadReceived = items.some(
    (item) =>
      minor(item.line.toString()) + minor(item.basket?.toString() ?? "0") > 0n,
  );
  const status =
    remaining === 0n
      ? "received"
      : hadReceived || totalReceived > 0n
        ? "partial"
        : "discrepancy";
  const after = await updateDelivery(
    store,
    delivery,
    { status, receiverId: actorId, reason },
    session,
  );
  const documentId = new ObjectId().toHexString();
  for (const item of items) {
    const value = received.get(String(item._id));
    if (!value) continue;
    await store.custody.updateOne(
      { _id: item._id },
      {
        $set: {
          transit: decimal(minor(item.transit.toString()) - value),
          line: decimal(minor(item.line.toString()) + value),
        },
      },
      { session },
    );
    await movement(
      store,
      row,
      item,
      null,
      "handover.receive",
      "transit",
      "line",
      value,
      documentId,
      actorId,
      reason || null,
      session,
    );
  }
  return { delivery: publicDelivery(after), documentId };
}

/** @param {Store} store @param {MaterialRequest} row @param {Delivery} delivery @param {unknown} input @param {string} actorId @param {Session} session */
export async function returnDelivery(
  store,
  row,
  delivery,
  input,
  actorId,
  session,
) {
  const { body, items } = await snapshot(store, delivery, input, session);
  const source = body.source;
  if (source !== "transit" && source !== "line")
    throw invalid("حساب مبدأ برگشت معتبر نیست.");
  if (
    source === "transit" &&
    !["partial", "discrepancy"].includes(delivery.status)
  )
    throw conflict("ماندهٔ در راه ابتدا باید در خط بررسی و مغایرت ثبت شود.");
  const reason = text(body.reason, 500);
  const returns = await amounts(store, items, body.items, source, session);
  if (!returns.size) throw invalid("حداقل یک مقدار برگشت وارد کنید.");
  const documentId = new ObjectId().toHexString();
  /** @type {Map<string,bigint>} */
  const reopened = new Map();
  let remainingTransit = 0n,
    totalLine = 0n;
  for (const item of items) {
    const value = returns.get(String(item._id)) ?? 0n;
    const transit =
      minor(item.transit.toString()) - (source === "transit" ? value : 0n);
    const line = minor(item.line.toString()) - (source === "line" ? value : 0n);
    remainingTransit += transit;
    totalLine +=
      minor(item.issued.toString()) -
      transit -
      minor(item.returned.toString()) -
      value;
    if (!value) continue;
    const balance = await loadBalance(store, item.cartonId, session);
    if (
      balance.warehouseId !== row.warehouseId ||
      balance.account !== "storage"
    )
      throw conflict("موقعیت فعلی کارتن مبدأ به انبار حواله تعلق ندارد.");
    await writeBalance(
      store,
      balance,
      { quantity: decimal(minor(balance.quantity.toString()) + value) },
      session,
    );
    await store.custody.updateOne(
      { _id: item._id },
      {
        $set: {
          transit: decimal(transit),
          line: decimal(line),
          returned: decimal(minor(item.returned.toString()) + value),
        },
      },
      { session },
    );
    await movement(
      store,
      row,
      item,
      balance,
      "handover.return",
      source,
      "storage",
      value,
      documentId,
      actorId,
      reason,
      session,
    );
    if (source === "transit")
      reopened.set(item.skuId, (reopened.get(item.skuId) ?? 0n) - value);
  }
  const status =
    remainingTransit > 0n
      ? totalLine > 0n
        ? "partial"
        : "discrepancy"
      : totalLine > 0n
        ? "received"
        : "returned";
  const after = await updateDelivery(
    store,
    delivery,
    { status, reason },
    session,
  );
  const updated = reopened.size
    ? await updateRequest(store, row, plan(row, reopened), session)
    : row;
  return {
    request: publicRequest(updated),
    delivery: publicDelivery(after),
    documentId,
  };
}
