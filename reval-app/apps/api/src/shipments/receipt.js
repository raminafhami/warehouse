import { createHash } from "node:crypto";
import { Decimal128, ObjectId } from "mongodb";
import { fields, text, versionInput } from "../identity/validation.js";
import {
  assertOpen,
  conflict,
  touchShipment,
  violation,
} from "./operations.js";
import { publicReceipt } from "./store.js";

/** @typedef {ReturnType<typeof import("./store.js").shipmentStore>} Store */
/** @typedef {import("./store.js").Shipment} Shipment */
/** @typedef {import("./store.js").Balance} Balance */
/** @typedef {import("./store.js").Ledger} Ledger */
/** @typedef {import("mongodb").ClientSession} Session */
/** @param {string} value */
const fingerprint = (value) => createHash("sha256").update(value).digest("hex");

/**
 * @param {Store} store @param {Shipment} shipment @param {unknown} input
 * @param {string | undefined} key @param {string} actorId @param {Session} session
 */
export async function receiveShipment(
  store,
  shipment,
  input,
  key,
  actorId,
  session,
) {
  if (!key || !/^[a-zA-Z0-9_-]{1,128}$/.test(key))
    throw violation("کلید تکرارناپذیری دریافت معتبر نیست.");
  const body = fields(input);
  const version = versionInput(body.version);
  const reason = text(body.reason, 500, true);
  const shipmentId = String(shipment._id);
  const commandId = fingerprint(
    JSON.stringify([actorId, "shipment.receive", key]),
  );
  const hash = fingerprint(JSON.stringify([shipmentId, version, reason]));
  const previous = await store.commands.findOne(
    { _id: commandId },
    { session },
  );
  if (previous) {
    if (previous.hash !== hash)
      throw conflict("کلید درخواست قبلاً برای دریافت دیگری استفاده شده است.");
    return { receipt: previous.result, replayed: true };
  }
  assertOpen(shipment);
  if (shipment.version !== version)
    throw conflict(
      "فهرست کارتن‌ها تغییر کرده است. محموله را دوباره بارگیری کنید.",
    );

  const pallets = await store.pallets
    .find({ shipmentId }, { session })
    .toArray();
  const active = await store.cartons
    .find({ shipmentId, state: { $in: ["scanned", "received"] } }, { session })
    .toArray();
  const pending = active.filter((carton) => carton.state === "scanned");
  if (!pending.length)
    throw violation("حداقل یک کارتن جدید برای دریافت ثبت کنید.");
  const palletIds = new Set(active.map((carton) => carton.palletId));
  const empty = pallets.find((pallet) => !palletIds.has(String(pallet._id)));
  if (empty) throw violation(`پالت ${empty.code} هیچ کارتنی ندارد.`);

  const totalReceived = shipment.receivedCartons + pending.length;
  const quarantinedCount = pending.filter(
    (carton) => carton.condition === "quarantine",
  ).length;
  const quarantinedCartons = shipment.quarantinedCartons + quarantinedCount;
  const countDifference = totalReceived - shipment.expectedCartons;
  const needsReview = countDifference !== 0 || quarantinedCartons !== 0;
  if (needsReview && !reason)
    throw violation(
      "برای اختلاف تعداد یا کارتن قرنطینه، شرح مغایرت را وارد کنید.",
    );
  const at = new Date();
  const status = needsReview ? "discrepancy" : "approved";
  const _id = new ObjectId();
  const documentId = String(_id);
  await touchShipment(store, shipment, session, {
    $set: {
      status,
      receivedCartons: totalReceived,
      quarantinedCartons,
      ...(needsReview
        ? { discrepancy: { reason, countDifference, quarantinedCartons, at } }
        : {}),
    },
    ...(needsReview ? {} : { $unset: { discrepancy: "" } }),
  });

  /** @type {Balance[]} */
  const balances = [];
  /** @type {Ledger[]} */
  const ledger = [];
  for (const carton of pending) {
    const cartonId = String(carton._id);
    const account =
      carton.condition === "quarantine" ? "quarantine" : "receiving";
    const common = {
      skuId: carton.skuId,
      cartonId,
      warehouseId: shipment.warehouseId,
      scope: shipment.scope,
      quantity: carton.quantity,
    };
    balances.push({
      _id: cartonId + ":" + account,
      ...common,
      shipmentId,
      palletId: carton.palletId,
      account,
      reserved: Decimal128.fromString("0"),
      version: 0,
    });
    ledger.push({
      _id: documentId + ":" + cartonId,
      ...common,
      documentType: "shipment.receipt",
      documentId,
      from: "external",
      to: account,
      actorId,
      at,
    });
  }
  await store.balances.insertMany(balances, { session });
  await store.ledger.insertMany(ledger, { session });
  await store.cartons.updateMany(
    { _id: { $in: pending.map((carton) => carton._id) }, state: "scanned" },
    { $set: { state: "received" } },
    { session },
  );
  /** @type {import("./store.js").Receipt} */
  const receipt = {
    _id,
    shipmentId,
    actorId,
    at,
    cartonCount: pending.length,
    quarantinedCount,
    totalReceived,
    status,
    reason,
  };
  await store.receipts.insertOne(receipt, { session });
  const result = publicReceipt(receipt);
  await store.commands.insertOne(
    { _id: commandId, hash, result, at },
    { session },
  );
  return { receipt: result, replayed: false };
}

/**
 * @param {Store} store @param {Shipment} shipment @param {unknown} input
 * @param {string} actorId @param {Session} session
 */
export async function resolveDiscrepancy(
  store,
  shipment,
  input,
  actorId,
  session,
) {
  const body = fields(input);
  if (shipment.status !== "discrepancy" || !shipment.discrepancy)
    throw conflict("مغایرت باز برای این محموله وجود ندارد.");
  if (
    versionInput(body.version) !== shipment.version ||
    shipment.scannedCartons !== shipment.receivedCartons
  ) {
    throw conflict(
      "ابتدا کارتن‌های جدید را دریافت و محموله را دوباره بارگیری کنید.",
    );
  }
  const receivedPallets = await store.cartons.distinct(
    "palletId",
    { shipmentId: String(shipment._id), state: "received" },
    { session },
  );
  if (receivedPallets.length !== shipment.palletCount) {
    throw violation("پالت بدون کارتن در محموله باقی مانده است.");
  }
  return touchShipment(store, shipment, session, {
    $set: {
      status: "approved",
      resolution: { reason: text(body.reason, 500), at: new Date(), actorId },
    },
  });
}
