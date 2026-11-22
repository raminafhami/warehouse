import { Decimal128 } from "mongodb";
import { badInput, objectId } from "../identity/validation.js";
import { filterSearch, scopeQuery } from "../inventory/queries.js";
import { amountText, minor } from "../inventory/amounts.js";
import { dayBucket, dayWindow } from "./calendar.js";

/** @typedef {ReturnType<typeof import("../assembly/store.js").assemblyStore>} Store */
/** @typedef {import("../identity/permissions.js").Grant} Grant */
/** @typedef {import("mongodb").Document} Doc */
/** @typedef {import("express").Request["query"]} Query */

const zero = Decimal128.fromString("0");
/** @param {Query} query */
export function filters(query) {
  const period = query.period ?? "all";
  if (period !== "all" && period !== "1" && period !== "7" && period !== "30")
    throw badInput();
  return {
    period,
    window: period === "all" ? null : dayWindow(Number(period)),
    lineId: query.lineId ? String(objectId(query.lineId)) : null,
    q: query.q ? filterSearch(query.q) : null,
  };
}
/** @typedef {ReturnType<typeof filters>} Filters */

/** @param {Pick<Store,"catalog">} store @param {Grant} grant */
export async function lineOptions(store, grant) {
  const scoped = store.catalog.records.aggregate([
    { $match: { kind: { $in: ["lines", "stations"] }, ...scopeQuery(grant) } },
    { $group: { _id: { $toObjectId: "$scope.lineId" } } },
    {
      $lookup: {
        from: store.catalog.records.collectionName,
        localField: "_id",
        foreignField: "_id",
        as: "line",
      },
    },
    { $unwind: "$line" },
    { $sort: { "line.name": 1 } },
    { $project: { _id: 0, id: { $toString: "$_id" }, name: "$line.name" } },
  ]);
  return scoped.toArray();
}

/** @param {Store} store @param {Grant} grant @param {Filters} filter */
function views(store, grant, filter) {
  const scope = scopeQuery(grant);
  const line = filter.lineId ? { "scope.lineId": filter.lineId } : {};
  const unsupportedLine = filter.lineId ? { _id: { $exists: false } } : {};
  const unitScope = { $and: [scope, line] };
  const unitJoin = [
    { $set: { unitKey: { $toObjectId: "$unitId" } } },
    {
      $lookup: {
        from: store.imei.units.collectionName,
        localField: "unitKey",
        foreignField: "_id",
        as: "unit",
      },
    },
    { $unwind: "$unit" },
    {
      $match: {
        $and: [
          scopeQuery(grant, ["unit.scope"]),
          ...(filter.lineId ? [{ "unit.scope.lineId": filter.lineId }] : []),
        ],
      },
    },
  ];
  return {
    shipments: {
      collection: store.shipments,
      pipeline: [{ $match: { $and: [scope, unsupportedLine] } }],
      date: "createdAt",
      columns: {
        code: "محموله",
        supplierName: "تأمین‌کننده",
        waybillNumber: "بارنامه",
        palletCount: "پالت",
        receivedCartons: "کارتن دریافتی",
        status: "وضعیت",
        createdAt: "تاریخ",
      },
      search: ["code", "supplierName", "waybillNumber"],
    },
    pallets: {
      collection: store.pallets,
      pipeline: shipmentJoin(store, grant, unsupportedLine),
      date: "at",
      columns: {
        code: "پالت",
        "shipment.code": "محموله",
        "shipment.supplierName": "تأمین‌کننده",
        at: "تاریخ",
      },
      search: ["code", "shipment.code", "shipment.supplierName"],
    },
    material: {
      collection: store.cartons,
      pipeline: shipmentJoin(store, grant, unsupportedLine),
      date: "at",
      columns: {
        code: "کارتن",
        skuCode: "کالا",
        lot: "بچ",
        quantity: "مقدار",
        "shipment.supplierName": "تأمین‌کننده",
        condition: "وضعیت",
        at: "تاریخ",
      },
      search: ["code", "skuCode", "lot", "shipment.supplierName"],
      total: "quantity",
    },
    balances: {
      collection: store.balances,
      pipeline: [
        { $match: { $and: [scope, unsupportedLine] } },
        { $set: { cartonKey: { $toObjectId: "$cartonId" } } },
        {
          $lookup: {
            from: store.cartons.collectionName,
            localField: "cartonKey",
            foreignField: "_id",
            as: "carton",
          },
        },
        { $unwind: "$carton" },
        ...shipmentJoin(store, grant, {}, "carton.shipmentId"),
      ],
      date: null,
      columns: {
        "carton.code": "کارتن",
        "carton.skuCode": "کالا",
        locationCode: "موقعیت",
        account: "حساب",
        quantity: "مانده",
        reserved: "رزرو",
        "shipment.supplierName": "تأمین‌کننده",
      },
      search: [
        "carton.code",
        "carton.skuCode",
        "locationCode",
        "shipment.supplierName",
      ],
      total: "quantity",
    },
    ledger: {
      collection: store.ledger,
      pipeline: [
        {
          $match: {
            $and: [
              scopeQuery(grant, ["scope", "fromScope"]),
              ...(filter.lineId ? [{ lineId: filter.lineId }] : []),
            ],
          },
        },
        { $set: { cartonKey: { $toObjectId: "$cartonId" } } },
        {
          $lookup: {
            from: store.cartons.collectionName,
            localField: "cartonKey",
            foreignField: "_id",
            as: "carton",
          },
        },
        {
          $set: {
            cartonCode: { $first: "$carton.code" },
            skuCode: { $first: "$carton.skuCode" },
          },
        },
      ],
      date: "at",
      columns: {
        documentType: "گردش",
        cartonCode: "کارتن",
        skuCode: "کالا",
        from: "مبدأ",
        to: "مقصد",
        quantity: "مقدار",
        at: "تاریخ",
      },
      search: ["cartonCode", "skuCode", "documentId", "documentType"],
      total: "quantity",
    },
    handover: {
      collection: store.requests,
      pipeline: [
        {
          $match: {
            $and: [
              scopeQuery(grant, ["lineScope", "warehouseScope"]),
              ...(filter.lineId ? [{ lineId: filter.lineId }] : []),
            ],
          },
        },
      ],
      date: "at",
      columns: {
        code: "درخواست",
        modelName: "مدل",
        lineName: "خط",
        warehouseName: "انبار",
        count: "گوشی",
        status: "وضعیت",
        at: "تاریخ",
      },
      search: ["code", "modelName", "lineName", "warehouseName"],
    },
    baskets: {
      collection: store.baskets,
      pipeline: [{ $match: unitScope }],
      date: "at",
      columns: {
        code: "سبد",
        unitCode: "گوشی",
        modelName: "مدل",
        lineName: "خط",
        status: "وضعیت",
        receivedAt: "دریافت",
        at: "تاریخ",
      },
      search: ["code", "unitCode", "modelName", "lineName"],
    },
    assembly: {
      collection: store.visits,
      pipeline: [{ $match: unitScope }],
      date: "entryAt",
      columns: {
        unitCode: "گوشی",
        stationName: "ایستگاه",
        lineName: "خط",
        enteredName: "اپراتور",
        status: "وضعیت",
        entryAt: "ورود",
        exitAt: "خروج",
      },
      search: ["unitCode", "stationName", "enteredName", "lineName"],
    },
    stage: {
      collection: store.results,
      pipeline: [{ $match: unitScope }],
      date: "at",
      columns: {
        unitCode: "گوشی",
        stationName: "ایستگاه",
        testName: "تست",
        outcome: "نتیجه",
        attempt: "تلاش",
        revision: "نسخه",
        at: "تاریخ",
      },
      search: ["unitCode", "stationName", "testName", "answer"],
    },
    final: {
      collection: store.finalChecks,
      pipeline: unitJoin,
      date: "at",
      columns: {
        "unit.code": "گوشی",
        "unit.lineName": "خط",
        item: "تست",
        round: "تلاش",
        outcome: "نتیجه",
        at: "تاریخ",
      },
      search: ["unit.code", "unit.numbers", "item"],
    },
    defects: {
      collection: store.defects,
      pipeline: [{ $match: unitScope }],
      date: "at",
      columns: {
        unitCode: "گوشی",
        testName: "تست",
        status: "وضعیت",
        reason: "شرح",
        at: "تاریخ",
      },
      search: ["unitCode", "testName", "reason"],
    },
    finished: {
      collection: store.finishedCartons,
      pipeline: [
        { $match: { $and: [scope, unsupportedLine] } },
        { $set: { units: { $size: "$members" } } },
      ],
      date: "at",
      columns: {
        code: "کارتن محصول",
        modelName: "مدل",
        colorName: "رنگ",
        units: "تعداد گوشی",
        status: "وضعیت",
        locationName: "موقعیت",
        placedAt: "جانمایی",
        at: "تاریخ",
      },
      search: ["code", "modelName", "members.numbers", "locationName"],
    },
    returns: {
      collection: store.returns,
      pipeline: [
        { $match: unitScope },
        { $set: { items: { $size: "$parts" } } },
      ],
      date: "at",
      columns: {
        code: "سند مرجوعی",
        supplierName: "تأمین‌کننده",
        items: "اقلام",
        status: "وضعیت",
        at: "تاریخ",
      },
      search: ["code", "supplierName", "parts.code"],
    },
  };
}
/** @param {Store} store @param {Grant} grant @param {Doc} additional @param {string} [shipmentField] */
function shipmentJoin(store, grant, additional, shipmentField = "shipmentId") {
  return [
    { $set: { shipmentKey: { $toObjectId: "$" + shipmentField } } },
    {
      $lookup: {
        from: store.shipments.collectionName,
        localField: "shipmentKey",
        foreignField: "_id",
        as: "shipment",
      },
    },
    { $unwind: "$shipment" },
    { $match: { $and: [scopeQuery(grant, ["shipment.scope"]), additional] } },
  ];
}
/** @type {string[]} */
export const reportIds = [
  "shipments",
  "pallets",
  "material",
  "balances",
  "ledger",
  "handover",
  "baskets",
  "assembly",
  "stage",
  "final",
  "defects",
  "returns",
  "finished",
];
/** @param {Store} store @param {Grant} grant @param {Filters} filter @param {string} kind @param {number} skip @param {number} size */
export function reportCursor(store, grant, filter, kind, skip, size) {
  const all = views(store, grant, filter),
    source = all[/** @type {keyof typeof all} */ (kind)];
  const columns = Object.entries(source.columns).map(([key, label]) => ({
    key,
    label,
  }));
  /** @type {Doc[]} */
  const pipeline = [...source.pipeline];
  if (source.date && filter.window)
    pipeline.push({ $match: { [source.date]: filter.window } });
  if (filter.q)
    pipeline.push({
      $match: { $or: source.search.map((key) => ({ [key]: filter.q })) },
    });
  const projection = Object.fromEntries(
    columns.map(({ key }, index) => ["f" + index, "$" + key]),
  );
  const order = source.date ? { [source.date]: -1, _id: -1 } : { _id: -1 };
  const collection = source.collection;
  return {
    columns,
    collection,
    pipeline,
    projection,
    order,
    skip,
    size,
    total: "total" in source ? source.total : null,
    dated: !!source.date,
  };
}

/** @param {ReturnType<typeof reportCursor>} report */
export async function reportPage(report) {
  const {
    columns,
    collection,
    pipeline,
    projection,
    order,
    skip,
    size,
    total,
    dated,
  } = report;
  const [data] = await collection
    .aggregate([
      ...pipeline,
      {
        $facet: {
          items: [
            { $sort: order },
            { $skip: skip },
            { $limit: size },
            { $project: projection },
          ],
          totals: [
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
                ...(total ? { quantity: { $sum: "$" + total } } : {}),
              },
            },
          ],
        },
      },
    ])
    .toArray();
  const summary = data?.totals[0];
  return {
    columns,
    dated,
    items: (data?.items ?? []).map((/** @type {Doc} */ row) =>
      columns.map((_, index) => cell(row["f" + index])),
    ),
    count: summary?.count ?? 0,
    quantity:
      summary?.quantity == null
        ? null
        : amountText(minor(summary.quantity.toString())),
  };
}

/** @param {Store} store @param {Grant} grant @param {Filters} filter */
export async function reportOverview(store, grant, filter) {
  const local = filter.window ? filter : { ...filter, window: dayWindow(30) };
  const productionScope = {
    $and: [
      scopeQuery(grant),
      ...(filter.lineId ? [{ "scope.lineId": filter.lineId }] : []),
      ...(filter.q
        ? [
            {
              $or: [
                { code: filter.q },
                { modelName: filter.q },
                { lineName: filter.q },
              ],
            },
          ]
        : []),
    ],
  };
  const storage = reportCursor(store, grant, filter, "balances", 0, 1);
  const receiving = reportCursor(store, grant, filter, "material", 0, 1);
  const defect = reportCursor(store, grant, local, "defects", 0, 1);
  const [production, balances, defects, suppliers] = await Promise.all([
    store.imei.units
      .aggregate([
        { $match: { $and: [productionScope, { qcPassedAt: local.window }] } },
        { $group: { _id: dayBucket("qcPassedAt"), value: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ])
      .toArray(),
    storage.collection
      .aggregate([
        ...storage.pipeline,
        { $group: { _id: "$carton.skuCode", value: { $sum: "$quantity" } } },
        { $sort: { value: -1, _id: 1 } },
        { $limit: 12 },
      ])
      .toArray(),
    defect.collection
      .aggregate([
        ...defect.pipeline,
        { $group: { _id: "$status", value: { $sum: 1 } } },
        { $sort: { value: -1, _id: 1 } },
        { $limit: 12 },
      ])
      .toArray(),
    receiving.collection
      .aggregate([
        ...receiving.pipeline,
        { $match: { state: "received" } },
        {
          $group: {
            _id: "$shipment.supplierName",
            value: { $sum: "$quantity" },
          },
        },
        { $sort: { value: -1, _id: 1 } },
        { $limit: 12 },
      ])
      .toArray(),
  ]);
  /** @param {Doc[]} rows */
  const points = (rows) =>
    rows.map((row) => ({ label: String(row._id), value: Number(row.value) }));
  return {
    production: points(production),
    balances: points(balances),
    defects: points(defects),
    suppliers: points(suppliers),
  };
}
/** @param {unknown} value */
export function cell(value) {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Decimal128) return amountText(minor(value.toString()));
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  return "";
}

/** @param {Store} store @param {Grant} grant @param {import("mongodb").ClientSession} session */
export async function ledgerSnapshot(store, grant, session) {
  const accounts = ["receiving", "storage", "quarantine"];
  const scoped = scopeQuery(grant);
  const legs = [
    { key: "to", scope: "scope", sign: 1 },
    { key: "from", scope: "effectiveFromScope", sign: -1 },
  ];
  const movements = await store.ledger
    .aggregate(
      [
        { $set: { effectiveFromScope: { $ifNull: ["$fromScope", "$scope"] } } },
        {
          $facet: Object.fromEntries(
            legs.map(({ key, scope, sign }) => [
              key,
              [
                {
                  $match: {
                    $and: [
                      scopeQuery(grant, [scope]),
                      { [key]: { $in: accounts } },
                    ],
                  },
                },
                {
                  $group: {
                    _id: { account: "$" + key, skuId: "$skuId" },
                    value: { $sum: { $multiply: ["$quantity", sign] } },
                  },
                },
              ],
            ]),
          ),
        },
      ],
      { session },
    )
    .toArray();
  const balances = await store.balances
    .aggregate(
      [
        { $match: scoped },
        {
          $group: {
            _id: { account: "$account", skuId: "$skuId" },
            value: { $sum: "$quantity" },
          },
        },
      ],
      { session },
    )
    .toArray();
  const skuIds = [
    ...new Set(
      [
        ...balances,
        ...(movements[0]?.from ?? []),
        ...(movements[0]?.to ?? []),
      ].map((row) => row._id.skuId),
    ),
  ];
  const skus = await store.catalog.records
    .find({ _id: { $in: skuIds.map(objectId) } }, { session })
    .toArray();
  const codes = new Map(skus.map((row) => [String(row._id), row.code]));
  const snapshots = [];
  for (const skuId of skuIds) {
    for (const account of accounts) {
      const existing = balances.find(
        (row) => row._id.account === account && row._id.skuId === skuId,
      );
      const current = minor((existing?.value ?? zero).toString());
      const expected = legs.reduce(
        (sum, { key }) =>
          sum +
          minor(
            (
              movements[0]?.[key].find(
                (/** @type {Doc} */ row) =>
                  row._id.account === account && row._id.skuId === skuId,
              )?.value ?? zero
            ).toString(),
          ),
        0n,
      );
      if (existing || expected)
        snapshots.push({
          sku: codes.get(skuId) ?? skuId,
          account,
          current: amountText(current),
          expected: amountText(expected),
          difference: amountText(current - expected),
          balanced: current === expected,
        });
    }
  }
  return snapshots.sort(
    (a, b) => a.sku.localeCompare(b.sku) || a.account.localeCompare(b.account),
  );
}

/** @param {Store} store @param {Grant} grant @param {Filters} filter */
export async function dashboard(store, grant, filter) {
  const scoped = {
    $and: [
      scopeQuery(grant),
      ...(filter.lineId ? [{ "scope.lineId": filter.lineId }] : []),
    ],
  };
  const last14 = dayWindow(14),
    last30 = dayWindow(30);
  const [
    production,
    quality,
    stations,
    defects,
    work,
    waitingBaskets,
    openDefects,
    incomingIssues,
    readyForFinal,
    packed,
    receivedCartons,
  ] = await Promise.all([
    store.imei.units
      .aggregate([
        { $match: { $and: [scoped, { qcPassedAt: last14 }] } },
        {
          $group: {
            _id: { day: dayBucket("qcPassedAt"), line: "$lineName" },
            count: { $sum: 1 },
          },
        },
        { $sort: { "_id.day": 1, "_id.line": 1 } },
      ])
      .toArray(),
    store.finalChecks
      .aggregate([
        { $match: { at: last14 } },
        { $set: { unitKey: { $toObjectId: "$unitId" } } },
        {
          $lookup: {
            from: store.imei.units.collectionName,
            localField: "unitKey",
            foreignField: "_id",
            as: "unit",
          },
        },
        { $unwind: "$unit" },
        {
          $match: {
            $and: [
              scopeQuery(grant, ["unit.scope"]),
              ...(filter.lineId
                ? [{ "unit.scope.lineId": filter.lineId }]
                : []),
            ],
          },
        },
        {
          $group: {
            _id: dayBucket("at"),
            count: { $sum: 1 },
            passed: { $sum: { $cond: [{ $eq: ["$outcome", "pass"] }, 1, 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray(),
    store.visits
      .aggregate([
        {
          $match: {
            $and: [scoped, { status: { $in: ["installing", "testing"] } }],
          },
        },
        {
          $group: {
            _id: { line: "$lineName", station: "$stationName" },
            count: { $sum: 1 },
          },
        },
        { $sort: { "_id.line": 1, "_id.station": 1 } },
      ])
      .toArray(),
    store.defects
      .aggregate([
        { $match: { $and: [scoped, { at: last30 }] } },
        { $set: { partKey: { $toObjectId: "$partId" } } },
        {
          $lookup: {
            from: store.parts.collectionName,
            localField: "partKey",
            foreignField: "_id",
            as: "part",
          },
        },
        {
          $group: {
            _id: { $ifNull: [{ $first: "$part.skuCode" }, "بدون قطعهٔ مشخص"] },
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1, _id: 1 } },
      ])
      .toArray(),
    store.baskets
      .aggregate([
        { $match: scoped },
        {
          $group: {
            _id: { line: "$lineName", status: "$status" },
            count: { $sum: 1 },
          },
        },
        { $sort: { "_id.line": 1, "_id.status": 1 } },
      ])
      .toArray(),
    store.baskets.countDocuments({ $and: [scoped, { status: "handed_over" }] }),
    store.defects.countDocuments({
      $and: [
        scoped,
        {
          status: {
            $in: [
              "technical",
              "escalated",
              "replacing",
              "rework",
              "retest",
              "retest_failed",
            ],
          },
        },
      ],
    }),
    filter.lineId
      ? null
      : store.shipments.countDocuments({
          $and: [scopeQuery(grant), { status: "discrepancy" }],
        }),
    store.baskets
      .aggregate([
        { $match: { $and: [scoped, { status: "received" }] } },
        {
          $set: {
            unitKey: { $toObjectId: "$unitId" },
            routeKey: { $toObjectId: "$routingVersionId" },
          },
        },
        {
          $lookup: {
            from: store.positions.collectionName,
            localField: "unitKey",
            foreignField: "_id",
            as: "position",
          },
        },
        { $unwind: "$position" },
        {
          $lookup: {
            from: store.catalog.versions.collectionName,
            localField: "routeKey",
            foreignField: "_id",
            as: "routing",
          },
        },
        { $unwind: "$routing" },
        {
          $lookup: {
            from: store.final.collectionName,
            localField: "unitKey",
            foreignField: "_id",
            as: "final",
          },
        },
        {
          $match: {
            $expr: { $eq: ["$position.next", { $size: "$routing.steps" }] },
            "final.status": { $nin: ["passed", "packed", "rework"] },
          },
        },
        { $count: "value" },
      ])
      .toArray(),
    grant.permissions.includes("finished:view")
      ? store.final
          .aggregate([
            { $match: { status: "packed" } },
            {
              $lookup: {
                from: store.imei.units.collectionName,
                localField: "_id",
                foreignField: "_id",
                as: "unit",
              },
            },
            { $unwind: "$unit" },
            {
              $match: {
                $and: [
                  scopeQuery(grant, ["unit.scope"]),
                  ...(filter.lineId
                    ? [{ "unit.scope.lineId": filter.lineId }]
                    : []),
                ],
              },
            },
            { $count: "value" },
          ])
          .toArray()
      : [],
    !filter.lineId && grant.permissions.includes("inventory:view")
      ? store.shipments
          .aggregate([
            { $match: scopeQuery(grant) },
            { $group: { _id: null, value: { $sum: "$receivedCartons" } } },
          ])
          .toArray()
      : [],
  ]);
  return {
    production,
    quality,
    stations,
    defects,
    work,
    ...(grant.permissions.includes("finished:view")
      ? { packed: packed[0]?.value ?? 0 }
      : {}),
    ...(!filter.lineId && grant.permissions.includes("inventory:view")
      ? { receivedCartons: receivedCartons[0]?.value ?? 0 }
      : {}),
    actions: {
      waitingBaskets,
      openDefects,
      incomingIssues,
      readyForFinal: readyForFinal[0]?.value ?? 0,
    },
  };
}
