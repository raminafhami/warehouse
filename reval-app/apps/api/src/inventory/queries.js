import { Decimal128 } from "mongodb";
import { scopeKeys } from "../identity/permissions.js";
import { text } from "../identity/validation.js";
import { amountText, minor } from "./amounts.js";

/** @typedef {import("../identity/permissions.js").Grant} Grant */
/** @typedef {ReturnType<typeof import("./store.js").inventoryStore>} Store */
/** @typedef {import("../shipments/store.js").Balance} Balance */
/** @typedef {import("../shipments/store.js").Ledger} Ledger */

/** @param {Grant} grant @param {string[]} [paths] */
export function scopeQuery(grant, paths = ["scope"]) {
  if (grant.organizationWide) return {};
  const conditions = paths.flatMap((path) =>
    grant.scopes
      .map((scope) =>
        Object.fromEntries(
          scopeKeys
            .filter((key) => scope[key])
            .map((key) => [path + "." + key, scope[key]]),
        ),
      )
      .filter((rule) => Object.keys(rule).length),
  );
  return conditions.length ? { $or: conditions } : { _id: { $exists: false } };
}

/** @param {unknown} value */
export function filterSearch(value) {
  return new RegExp(
    text(value, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "i",
  );
}

/** @param {import("mongodb").Document} filter @param {RegExp | undefined} search */
export function balancePipeline(filter, search) {
  const pipeline = [
    { $match: filter },
    {
      $set: {
        cartonKey: { $toObjectId: "$cartonId" },
        shipmentKey: { $toObjectId: "$shipmentId" },
      },
    },
    {
      $lookup: {
        from: "reval_material_cartons",
        localField: "cartonKey",
        foreignField: "_id",
        as: "carton",
      },
    },
    { $unwind: "$carton" },
    {
      $lookup: {
        from: "reval_shipments",
        localField: "shipmentKey",
        foreignField: "_id",
        as: "shipment",
      },
    },
    { $unwind: "$shipment" },
    {
      $set: {
        cartonCode: "$carton.code",
        skuCode: "$carton.skuCode",
        supplierId: "$shipment.supplierId",
        supplierName: "$shipment.supplierName",
        shipmentCode: "$shipment.code",
        palletId: {
          $cond: [
            { $eq: [{ $type: "$palletId" }, "missing"] },
            "$carton.palletId",
            "$palletId",
          ],
        },
      },
    },
    { $unset: ["carton", "shipment", "cartonKey", "shipmentKey"] },
  ];
  if (search)
    pipeline.push({
      $match: {
        $or: [
          { cartonCode: search },
          { skuCode: search },
          { locationCode: search },
          { supplierName: search },
        ],
      },
    });
  return pipeline;
}

/** @param {import("mongodb").Document[]} pipeline @param {string} group */
export function groupedStock(pipeline, group) {
  if (group === "pallets")
    return [
      ...pipeline,
      { $match: { palletId: { $type: "string" } } },
      {
        $group: {
          _id: "$palletId",
          cartonCount: { $sum: 1 },
          source: { $first: "$supplierName" },
          locations: { $addToSet: { $ifNull: ["$locationCode", "$account"] } },
          items: { $push: { cartonId: "$cartonId", version: "$version" } },
          hasQuarantine: { $max: { $eq: ["$account", "quarantine"] } },
        },
      },
      { $set: { palletKey: { $toObjectId: "$_id" } } },
      {
        $lookup: {
          from: "reval_pallets",
          localField: "palletKey",
          foreignField: "_id",
          as: "pallet",
        },
      },
      { $unwind: "$pallet" },
      { $set: { code: "$pallet.code" } },
      { $unset: ["palletKey", "pallet"] },
    ];
  const zero = Decimal128.fromString("0");
  return [
    ...pipeline,
    {
      $group: {
        _id: { skuId: "$skuId", supplierId: "$supplierId" },
        skuCode: { $first: "$skuCode" },
        supplierName: { $first: "$supplierName" },
        receiving: {
          $sum: {
            $cond: [{ $eq: ["$account", "receiving"] }, "$quantity", zero],
          },
        },
        storage: {
          $sum: {
            $cond: [{ $eq: ["$account", "storage"] }, "$quantity", zero],
          },
        },
        quarantine: {
          $sum: {
            $cond: [{ $eq: ["$account", "quarantine"] }, "$quantity", zero],
          },
        },
        reserved: { $sum: "$reserved" },
      },
    },
  ];
}

/** @param {Store} store @param {Balance} balance @param {import("mongodb").ClientSession} session */
export async function reconcile(store, balance, session) {
  const rows = await store.ledger
    .find({ cartonId: balance.cartonId }, { session })
    .toArray();
  const buckets = new Map();
  /** @param {string} warehouse @param {string} account @param {string | null | undefined} location */
  const bucket = (warehouse, account, location) =>
    JSON.stringify([warehouse, account, location ?? null]);
  /** @param {Ledger} row @param {Ledger["from"]} account @param {string|null|undefined} location */
  function reference(row, account, location) {
    switch (account) {
      case "basket":
        return row.basketId;
      case "consumed":
        return row.unitId;
      case "defective":
      case "defect_store":
      case "supplier_return":
      case "replacement_reserved":
        return row.partId;
      case "transit":
      case "line":
        return row.lineId;
      default:
        return location;
    }
  }
  for (const row of rows) {
    const amount = minor(row.quantity.toString());
    if (row.from !== "external" && row.from !== "adjustment") {
      const key = bucket(
        row.fromWarehouseId ?? row.warehouseId,
        row.from,
        reference(row, row.from, row.fromLocationId),
      );
      buckets.set(key, (buckets.get(key) ?? 0n) - amount);
    }
    if (row.to !== "adjustment") {
      const key = bucket(
        row.warehouseId,
        row.to,
        reference(row, row.to, row.toLocationId),
      );
      buckets.set(key, (buckets.get(key) ?? 0n) + amount);
    }
  }
  const current = bucket(
    balance.warehouseId,
    balance.account,
    balance.locationId,
  );
  const actual = minor(balance.quantity.toString());
  const expected = buckets.get(current) ?? 0n;
  const custody = await store.custody
    .find({ cartonId: balance.cartonId }, { session })
    .toArray();
  const positions = new Map([[current, actual]]);
  for (const row of custody) {
    for (const account of /** @type {const} */ (["transit", "line"])) {
      const key = bucket(row.warehouseId, account, row.lineId);
      positions.set(
        key,
        (positions.get(key) ?? 0n) + minor(row[account].toString()),
      );
    }
  }
  const parts = await store.parts
    .find(
      {
        cartonId: balance.cartonId,
        state: {
          $in: [
            "allocated",
            "installed",
            "defective",
            "defect_store",
            "supplier_return",
            "replacement_reserved",
          ],
        },
      },
      { session },
    )
    .toArray();
  const byCustody = new Map();
  const consumedByCustody = new Map();
  const nonAllocatable = {
    defective: 0n,
    defect_store: 0n,
    supplier_return: 0n,
    replacement_reserved: 0n,
  };
  for (const part of parts) {
    const amount = minor(part.quantity.toString());
    if (part.state !== "allocated" && part.state !== "installed") {
      if (part.state in nonAllocatable)
        nonAllocatable[
          /** @type {keyof typeof nonAllocatable} */ (part.state)
        ] += amount;
      positions.set(
        bucket(part.warehouseId, part.state, String(part._id)),
        amount,
      );
      continue;
    }
    const installed = part.state === "installed";
    const key = installed
      ? bucket(part.warehouseId, "consumed", part.unitId)
      : bucket(part.warehouseId, "basket", part.basketId);
    const quantities = installed ? consumedByCustody : byCustody;
    positions.set(key, (positions.get(key) ?? 0n) + amount);
    quantities.set(
      part.custodyId,
      (quantities.get(part.custodyId) ?? 0n) + amount,
    );
  }
  const basketBalance = parts
    .filter((part) => part.state === "allocated")
    .reduce((sum, part) => sum + minor(part.quantity.toString()), 0n);
  const custodyBasketBalance = custody.reduce(
    (sum, row) => sum + minor(row.basket?.toString() ?? "0"),
    0n,
  );
  const matchingParts =
    custodyBasketBalance === basketBalance &&
    custody.every(
      (row) =>
        minor(row.basket?.toString() ?? "0") ===
          (byCustody.get(String(row._id)) ?? 0n) &&
        minor(row.consumed?.toString() ?? "0") ===
          (consumedByCustody.get(String(row._id)) ?? 0n),
    );
  const balancedStock = [
    ...new Set([...positions.keys(), ...buckets.keys()]),
  ].every((key) => (positions.get(key) ?? 0n) === (buckets.get(key) ?? 0n));
  const reservations = await store.reservations
    .find({ cartonId: balance.cartonId, state: "active" }, { session })
    .toArray();
  const expectedReserved = reservations.reduce(
    (sum, row) => sum + minor(row.quantity.toString()),
    0n,
  );
  const reserved = minor(balance.reserved.toString());
  return {
    cartonId: balance.cartonId,
    actual: amountText(actual),
    expected: amountText(expected),
    reserved: amountText(reserved),
    expectedReserved: amountText(expectedReserved),
    ...(custody.length
      ? {
          transit: amountText(
            custody.reduce(
              (sum, row) => sum + minor(row.transit.toString()),
              0n,
            ),
          ),
          line: amountText(
            custody.reduce((sum, row) => sum + minor(row.line.toString()), 0n),
          ),
        }
      : {}),
    ...(parts.length || custodyBasketBalance
      ? { basket: amountText(basketBalance) }
      : {}),
    ...(consumedByCustody.size
      ? {
          consumed: amountText(
            [...consumedByCustody.values()].reduce(
              (sum, amount) => sum + amount,
              0n,
            ),
          ),
        }
      : {}),
    ...(Object.values(nonAllocatable).some((amount) => amount > 0n)
      ? {
          nonAllocatable: Object.fromEntries(
            Object.entries(nonAllocatable).map(([account, amount]) => [
              account,
              amountText(amount),
            ]),
          ),
        }
      : {}),
    balanced: balancedStock && matchingParts && reserved === expectedReserved,
  };
}
