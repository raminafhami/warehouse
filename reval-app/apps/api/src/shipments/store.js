/** @typedef {import("mongodb").ObjectId} Id */
/** @typedef {import("mongodb").Decimal128} Decimal */
/** @typedef {import("../identity/permissions.js").Scope} Scope */
/** @typedef {{fileId: string, name: string, contentType: string, size: number}} Waybill */
/** @typedef {{ _id: Id, sequence: number, code: string, supplierId: string, supplierName: string, warehouseId: string, warehouseName: string, scope: Scope, waybillNumber: string, purchaseOrder: string, expectedCartons: number, scannedCartons: number, receivedCartons: number, quarantinedCartons: number, palletCount: number, status: "receiving" | "discrepancy" | "approved", notes: string, createdAt: Date, createdBy: string, version: number, waybill?: Waybill, discrepancy?: { reason: string, countDifference: number, quarantinedCartons: number, at: Date }, resolution?: { reason: string, at: Date, actorId: string } }} Shipment */
/** @typedef {{ _id: Id, shipmentId: string, code: string, at: Date }} Pallet */
/** @typedef {{ _id: Id, shipmentId: string, palletId: string, code: string, skuId: string, skuCode: string, lot?: string, quantity: Decimal, condition: "accepted" | "quarantine", state: "scanned" | "received" | "removed", at: Date }} Carton */
/** @typedef {{ _id: Id, shipmentId: string, actorId: string, at: Date, cartonCount: number, quarantinedCount: number, totalReceived: number, status: Shipment["status"], reason: string }} Receipt */
/** @typedef {{ _id: string, hash: string, result: ReturnType<typeof publicReceipt>, at: Date }} Command */
/** @typedef {{ _id: Id, shipmentId: string, name: string, type: string, content: import("mongodb").Binary, checksum: string, at: Date }} StoredFile */
/** @typedef {{ _id: string, skuId: string, cartonId: string, shipmentId: string, warehouseId: string, scope: Scope, account: "receiving" | "quarantine" | "storage", locationId?: string | null, locationCode?: string | null, palletId?: string | null, quantity: Decimal, reserved: Decimal, version: number }} Balance */
/** @typedef {Balance["account"] | "transit" | "line" | "basket" | "consumed" | "defective" | "defect_store" | "supplier_return" | "replacement_reserved"} StockAccount */
/** @typedef {{ _id: string, documentType: "shipment.receipt" | "inventory.move" | "inventory.adjustment" | "handover.issue" | "handover.receive" | "handover.return" | "basket.part.allocate" | "basket.part.return" | "assembly.part.install" | "defect.movement", documentId: string, skuId: string, cartonId: string, warehouseId: string, scope: Scope, from: StockAccount | "external" | "adjustment", to: StockAccount | "adjustment", fromWarehouseId?: string, fromScope?: Scope, fromLocationId?: string | null, fromLocationCode?: string | null, toLocationId?: string | null, toLocationCode?: string | null, lineId?: string, basketId?: string, partId?:string, unitId?:string, quantity: Decimal, actorId: string, at: Date, reason?: string, reversesId?: string }} Ledger */

/** @param {import("mongoose").Connection} database */
export function shipmentStore(database) {
  const db = database.db;
  if (!db) throw new Error("Shipment database is unavailable.");
  return {
    shipments: /** @type {import("mongodb").Collection<Shipment>} */ (
      db.collection("reval_shipments")
    ),
    pallets: /** @type {import("mongodb").Collection<Pallet>} */ (
      db.collection("reval_pallets")
    ),
    cartons: /** @type {import("mongodb").Collection<Carton>} */ (
      db.collection("reval_material_cartons")
    ),
    receipts: /** @type {import("mongodb").Collection<Receipt>} */ (
      db.collection("reval_shipment_receipts")
    ),
    balances: /** @type {import("mongodb").Collection<Balance>} */ (
      db.collection("reval_stock_balances")
    ),
    ledger: /** @type {import("mongodb").Collection<Ledger>} */ (
      db.collection("reval_stock_ledger")
    ),
    commands: /** @type {import("mongodb").Collection<Command>} */ (
      db.collection("reval_receipt_commands")
    ),
    files: /** @type {import("mongodb").Collection<StoredFile>} */ (
      db.collection("reval_file_assets")
    ),
    counters:
      /** @type {import("mongodb").Collection<{_id: string, value: number}>} */ (
        db.collection("reval_counters")
      ),
  };
}

/** @param {ReturnType<typeof shipmentStore>} store */
export async function initializeShipments(store) {
  await store.shipments.createIndex({ code: 1 }, { unique: true });
  await store.shipments.createIndex({ "scope.warehouseId": 1, createdAt: -1 });
  await store.shipments.createIndex({ "scope.branchId": 1, createdAt: -1 });
  await store.pallets.createIndex({ code: 1 }, { unique: true });
  await store.pallets.createIndex({ shipmentId: 1 });
  await store.cartons.createIndex({ code: 1 }, { unique: true });
  await store.cartons.createIndex({ shipmentId: 1, state: 1 });
  await store.receipts.createIndex({ shipmentId: 1, at: -1 });
  await store.balances.createIndex({ warehouseId: 1, account: 1, skuId: 1 });
  await store.ledger.createIndex({ documentId: 1 });
  await store.counters.updateOne(
    { _id: "shipment" },
    { $setOnInsert: { value: 0 } },
    { upsert: true },
  );
}

/** @param {Shipment} record */
export function publicShipment(record) {
  const { _id, ...rest } = record;
  return { id: String(_id), ...rest };
}
/** @param {Pallet} record */
export function publicPallet(record) {
  const { _id, ...rest } = record;
  return { id: String(_id), ...rest };
}
/** @param {Carton} record */
export function publicCarton(record) {
  const { _id, quantity, ...rest } = record;
  return { id: String(_id), ...rest, quantity: quantity.toString() };
}
/** @param {Receipt} record */
export function publicReceipt(record) {
  const { _id, ...rest } = record;
  return { id: String(_id), ...rest };
}
