import { shipmentStore } from "../shipments/store.js";

/** @typedef {{_id: import("mongodb").ObjectId, cartonId: string, skuId: string, scope: import("../identity/permissions.js").Scope, warehouseId: string, quantity: import("mongodb").Decimal128, state: "active" | "released" | "consumed", requestId?: string, actorId: string, reason: string, at: Date, releasedAt?: Date, releasedBy?: string}} Reservation */
/** @typedef {{_id:import("mongodb").ObjectId, deliveryId:string, requestId:string, cartonId:string, cartonCode:string, skuId:string, skuCode:string, warehouseId:string, warehouseScope:import("../identity/permissions.js").Scope, lineId:string, lineScope:import("../identity/permissions.js").Scope, issued:import("mongodb").Decimal128, transit:import("mongodb").Decimal128, line:import("mongodb").Decimal128, basket?:import("mongodb").Decimal128, consumed?:import("mongodb").Decimal128, returned:import("mongodb").Decimal128}} Custody */

/** @param {import("mongoose").Connection} database */
export function inventoryStore(database) {
  if (!database.db) throw new Error("Inventory database is unavailable.");
  return {
    ...shipmentStore(database),
    reservations: /** @type {import("mongodb").Collection<Reservation>} */ (
      database.db.collection("reval_reservations")
    ),
    parts:
      /** @type {import('mongodb').Collection<import('../basket/store.js').Part>} */ (
        database.db.collection("reval_basket_parts")
      ),
    custody: /** @type {import("mongodb").Collection<Custody>} */ (
      database.db.collection("reval_material_custody")
    ),
  };
}

/** @param {ReturnType<typeof inventoryStore>} store */
export async function initializeInventory(store) {
  await store.balances.createIndex({ cartonId: 1 }, { unique: true });
  await store.balances.createIndex({ locationId: 1, account: 1 });
  await store.ledger.createIndex({ cartonId: 1, at: -1 });
  await store.ledger.createIndex(
    { reversesId: 1 },
    { unique: true, sparse: true },
  );
  await store.reservations.createIndex({ cartonId: 1, state: 1 });
}
