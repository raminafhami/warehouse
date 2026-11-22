import { Decimal128, ObjectId } from "mongodb";
import { ApiError } from "../http-error.js";
import {
  activeReference,
  checkLocationCompatibility,
  lookup,
} from "../catalog/records.js";
import { idText, list } from "../catalog/validation.js";
import { fields, text, versionInput } from "../identity/validation.js";
import { amountText, commandAmount, decimal, minor } from "./amounts.js";

/** @typedef {ReturnType<typeof import("./store.js").inventoryStore>} Store */
/** @typedef {ReturnType<typeof import("../catalog/store.js").catalogStore>} Catalog */
/** @typedef {import("../shipments/store.js").Balance} Balance */
/** @typedef {import("../shipments/store.js").Ledger} Ledger */
/** @typedef {import("../catalog/store.js").Entry} Entry */
/** @typedef {import("mongodb").ClientSession} Session */
/** @typedef {import("../identity/permissions.js").Scope} Scope */

export const missingStock = () =>
  new ApiError(404, "STOCK_NOT_FOUND", "موجودی یا سند پیدا نشد.");
/** @param {string} message */
const no = (message) => new ApiError(409, "STOCK_CONFLICT", message);
const stale = () =>
  no("مانده یا محل کارتن تغییر کرده است. دوباره بارگیری کنید.");

/** @param {Store} store @param {string} cartonId @param {Session} [session] */
export async function loadBalance(store, cartonId, session) {
  const balance = await store.balances.findOne({ cartonId }, { session });
  if (!balance) throw missingStock();
  return balance;
}
/** @param {Balance} balance @param {unknown} version */
function verifyVersion(balance, version) {
  if (versionInput(version) !== balance.version) throw stale();
}
/** @param {Store} store @param {Balance} balance @param {Partial<Balance>} updates @param {Session} session */
export async function writeBalance(store, balance, updates, session) {
  const result = await store.balances.findOneAndUpdate(
    { _id: balance._id, version: balance.version },
    {
      $set: updates,
      $inc: { version: 1 },
    },
    { returnDocument: "after", session },
  );
  if (!result) throw stale();
  return result;
}
/** @param {Balance} balance */
export function publicBalance(balance) {
  const { _id, quantity, reserved, ...rest } = balance;
  return {
    id: _id,
    ...rest,
    quantity: amountText(minor(quantity.toString())),
    reserved: amountText(minor(reserved.toString())),
    available:
      balance.account === "storage"
        ? amountText(minor(quantity.toString()) - minor(reserved.toString()))
        : "0",
  };
}
/** @param {Ledger} record */
export function publicLedger(record) {
  const { _id, quantity, ...rest } = record;
  return { id: _id, ...rest, quantity: amountText(minor(quantity.toString())) };
}

/** @param {Catalog} catalog @param {Balance} balance @param {Session} session */
export async function unitFor(catalog, balance, session) {
  const sku = await lookup(catalog, "skus", balance.skuId, session);
  if (!sku) throw missingStock();
  const part = await lookup(
    catalog,
    "partTypes",
    String(sku.data.partTypeId),
    session,
  );
  if (!part) throw missingStock();
  const unit = await lookup(
    catalog,
    "units",
    String(part.data.unitId),
    session,
  );
  if (!unit) throw missingStock();
  return { scale: Number(unit.data.scale), step: String(unit.data.step) };
}

/** @param {Catalog} catalog @param {unknown} input @param {Session} session */
async function destination(catalog, input, session) {
  const location = await activeReference(
    catalog,
    "locations",
    idText(input),
    session,
  );
  const warehouse = await activeReference(
    catalog,
    "warehouses",
    String(location.parentId),
    session,
  );
  return { location, warehouse };
}

/** @param {Store} store @param {Catalog} catalog @param {Balance} balance @param {{location:Entry,warehouse:Entry}} target @param {string | null} palletId @param {string} actorId @param {string} documentId @param {Session} session */
async function moveOne(
  store,
  catalog,
  balance,
  target,
  palletId,
  actorId,
  documentId,
  session,
) {
  if (balance.account === "quarantine")
    throw no("کارتن قرنطینه از مسیر جانمایی آزاد منتقل نمی‌شود.");
  if (
    balance.locationId === String(target.location._id) &&
    balance.account === "storage"
  ) {
    throw no("کارتن هم‌اکنون در همین موقعیت است.");
  }
  if (minor(balance.reserved.toString()) > 0n)
    throw no("ابتدا رزروهای فعال این کارتن را آزاد کنید.");
  if (minor(balance.quantity.toString()) <= 0n)
    throw no("کارتن موجودی قابل انتقال ندارد.");
  const sku = await lookup(catalog, "skus", balance.skuId, session);
  if (!sku) throw missingStock();
  checkLocationCompatibility(target.location, {
    partTypeId: String(sku.data.partTypeId),
  });

  const warehouseId = String(target.warehouse._id);
  if (warehouseId !== balance.warehouseId) {
    const zero = Decimal128.fromString("0");
    const active = await store.custody.findOne(
      {
        cartonId: balance.cartonId,
        $or: [
          { transit: { $gt: zero } },
          { line: { $gt: zero } },
          { basket: { $gt: zero } },
        ],
      },
      { session, projection: { _id: 1 } },
    );
    if (active)
      throw no(
        "تا تعیین تکلیف مواد در راه، خط یا سبد، انتقال کارتن به انبار دیگر ممکن نیست.",
      );
  }
  const scope = target.warehouse.scope;
  const locationId = String(target.location._id);
  const after = await writeBalance(
    store,
    balance,
    {
      warehouseId,
      scope,
      locationId,
      locationCode: target.location.code,
      account: "storage",
      palletId,
    },
    session,
  );
  await store.ledger.insertOne(
    {
      _id: documentId + ":" + balance.cartonId,
      documentType: "inventory.move",
      documentId,
      skuId: balance.skuId,
      cartonId: balance.cartonId,
      warehouseId,
      scope,
      fromWarehouseId: balance.warehouseId,
      fromScope: balance.scope,
      fromLocationId: balance.locationId,
      fromLocationCode: balance.locationCode,
      toLocationId: locationId,
      toLocationCode: target.location.code,
      from: balance.account,
      to: "storage",
      quantity: balance.quantity,
      actorId,
      at: new Date(),
    },
    { session },
  );
  return after;
}

/** @param {Store} store @param {Catalog} catalog @param {string} cartonId @param {unknown} input @param {string} actorId @param {Session} session @param {(scope:Scope)=>void} authorize */
export async function moveCarton(
  store,
  catalog,
  cartonId,
  input,
  actorId,
  session,
  authorize,
) {
  const body = fields(input);
  const balance = await loadBalance(store, cartonId, session);
  authorize(balance.scope);
  verifyVersion(balance, body.version);
  const target = await destination(catalog, body.locationId, session);
  authorize(target.warehouse.scope);
  const documentId = new ObjectId().toHexString();
  return {
    documentId,
    data: [
      publicBalance(
        await moveOne(
          store,
          catalog,
          balance,
          target,
          null,
          actorId,
          documentId,
          session,
        ),
      ),
    ],
  };
}

/** @param {Store} store @param {string} palletId @param {Session} session */
async function palletBalances(store, palletId, session) {
  const cartons = await store.cartons
    .find({ palletId, state: "received" }, { session })
    .sort({ code: 1 })
    .toArray();
  const balances = await store.balances
    .find(
      { cartonId: { $in: cartons.map((carton) => String(carton._id)) } },
      { session },
    )
    .toArray();
  const byCarton = new Map(
    balances.map((balance) => [balance.cartonId, balance]),
  );
  return cartons.flatMap((carton) => {
    const balance = byCarton.get(String(carton._id));
    return balance &&
      (balance.palletId === undefined || balance.palletId === palletId)
      ? [balance]
      : [];
  });
}

/** @param {Store} store @param {Catalog} catalog @param {string} palletId @param {unknown} input @param {string} actorId @param {Session} session @param {(scope:Scope)=>void} authorize */
export async function movePallet(
  store,
  catalog,
  palletId,
  input,
  actorId,
  session,
  authorize,
) {
  const body = fields(input);
  const versions = new Map(
    list(body.items).map((item) => {
      const value = fields(item);
      return [idText(value.cartonId), versionInput(value.version)];
    }),
  );
  const balances = await palletBalances(store, palletId, session);
  if (!balances.length) throw missingStock();
  for (const balance of balances) authorize(balance.scope);
  if (
    versions.size !== balances.length ||
    balances.some(
      (balance) => versions.get(balance.cartonId) !== balance.version,
    )
  )
    throw stale();
  if (balances.some((balance) => balance.account === "quarantine"))
    throw no(
      "پالت شامل کارتن قرنطینه است. کارتن‌های سالم را جداگانه جانمایی کنید.",
    );
  const target = await destination(catalog, body.locationId, session);
  authorize(target.warehouse.scope);
  const documentId = new ObjectId().toHexString();
  const data = [];
  for (const balance of balances)
    data.push(
      publicBalance(
        await moveOne(
          store,
          catalog,
          balance,
          target,
          palletId,
          actorId,
          documentId,
          session,
        ),
      ),
    );
  return { documentId, data };
}

/** @param {Store} store @param {Catalog} catalog @param {Balance} balance @param {unknown} input @param {string} actorId @param {Session} session */
export async function adjustBalance(
  store,
  catalog,
  balance,
  input,
  actorId,
  session,
) {
  const body = fields(input);
  verifyVersion(balance, body.version);
  const reason = text(body.reason, 500);
  let value;
  let reversesId;
  if (body.reversesId) {
    reversesId = text(body.reversesId, 80);
    const original = await store.ledger.findOne(
      {
        _id: reversesId,
        cartonId: balance.cartonId,
        documentType: "inventory.adjustment",
      },
      { session },
    );
    if (!original || original.reversesId) throw missingStock();
    if (await store.ledger.findOne({ reversesId }, { session }))
      throw no("اصلاح اولیه قبلاً جبران شده است.");
    const before = minor(original.quantity.toString());
    value = original.to === "adjustment" ? before : -before;
  } else
    value = commandAmount(
      body.quantity,
      await unitFor(catalog, balance, session),
      true,
    );
  const before = minor(balance.quantity.toString());
  const after = before + value;
  if (after < 0n || after < minor(balance.reserved.toString()))
    throw no("اصلاح موجودی را منفی یا کمتر از رزرو فعال می‌کند.");
  const result = await writeBalance(
    store,
    balance,
    { quantity: decimal(after) },
    session,
  );
  const documentId = new ObjectId().toHexString();
  /** @type {Ledger} */
  const entry = {
    _id: documentId,
    documentType: "inventory.adjustment",
    documentId,
    skuId: balance.skuId,
    cartonId: balance.cartonId,
    warehouseId: balance.warehouseId,
    scope: balance.scope,
    fromLocationId: value < 0n ? balance.locationId : null,
    fromLocationCode: value < 0n ? balance.locationCode : null,
    toLocationId: value > 0n ? balance.locationId : null,
    toLocationCode: value > 0n ? balance.locationCode : null,
    from: value < 0n ? balance.account : "adjustment",
    to: value > 0n ? balance.account : "adjustment",
    quantity: decimal(value < 0n ? -value : value),
    actorId,
    at: new Date(),
    reason,
    ...(reversesId ? { reversesId } : {}),
  };
  await store.ledger.insertOne(entry, { session });
  return { balance: publicBalance(result), adjustment: publicLedger(entry) };
}

/** @param {Store} store @param {Catalog} catalog @param {Balance} balance @param {unknown} input @param {string} actorId @param {Session} session @param {string} [requestId] */
export async function reserve(
  store,
  catalog,
  balance,
  input,
  actorId,
  session,
  requestId,
) {
  const body = fields(input);
  verifyVersion(balance, body.version);
  if (balance.account !== "storage")
    throw no("رزرو فقط پس از جانمایی موجودی سالم ممکن است.");
  const value = commandAmount(
    body.quantity,
    await unitFor(catalog, balance, session),
  );
  const current = minor(balance.reserved.toString());
  if (value + current > minor(balance.quantity.toString()))
    throw no("موجودی آزاد کافی نیست.");
  const after = await writeBalance(
    store,
    balance,
    { reserved: decimal(value + current) },
    session,
  );
  /** @type {import("./store.js").Reservation} */
  const reservation = {
    _id: new ObjectId(),
    cartonId: balance.cartonId,
    skuId: balance.skuId,
    warehouseId: balance.warehouseId,
    scope: balance.scope,
    quantity: decimal(value),
    state: "active",
    actorId,
    reason: text(body.reason, 500, true),
    at: new Date(),
    ...(requestId ? { requestId } : {}),
  };
  await store.reservations.insertOne(reservation, { session });
  return {
    balance: publicBalance(after),
    reservation: publicReservation(reservation),
  };
}

/** @param {import("./store.js").Reservation} reservation */
export function publicReservation(reservation) {
  const { _id, quantity, ...rest } = reservation;
  return {
    id: String(_id),
    quantity: amountText(minor(quantity.toString())),
    ...rest,
  };
}

/** @param {Store} store @param {Balance} balance @param {ObjectId} id @param {unknown} input @param {string} actorId @param {Session} session @param {string} [requestId] */
export async function release(
  store,
  balance,
  id,
  input,
  actorId,
  session,
  requestId,
) {
  verifyVersion(balance, fields(input).version);
  const row = await store.reservations.findOne(
    { _id: id, cartonId: balance.cartonId },
    { session },
  );
  if (!row) throw missingStock();
  if (row.requestId !== requestId)
    throw no("رزرو وابسته به درخواست از مسیر تحویل مدیریت می‌شود.");
  if (row.state !== "active") throw no("این رزرو قبلاً آزاد شده است.");
  const next =
    minor(balance.reserved.toString()) - minor(row.quantity.toString());
  if (next < 0n) throw no("ماندهٔ رزرو با سند سازگار نیست.");
  const after = await writeBalance(
    store,
    balance,
    { reserved: decimal(next) },
    session,
  );
  const updated = await store.reservations.findOneAndUpdate(
    { _id: id, state: "active" },
    {
      $set: { state: "released", releasedAt: new Date(), releasedBy: actorId },
    },
    { returnDocument: "after", session },
  );
  if (!updated) throw stale();
  return {
    balance: publicBalance(after),
    reservation: publicReservation(updated),
  };
}
