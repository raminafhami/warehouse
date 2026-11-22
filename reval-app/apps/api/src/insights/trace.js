import { objectId } from "../identity/validation.js";
import { hasPermission } from "../identity/permissions.js";
import { scopeQuery } from "../inventory/queries.js";
import { publicRow } from "../imei/store.js";
import { publicPart } from "../basket/parts.js";
import { identityStore } from "../identity/store.js";
import { missing } from "../assembly/workflow.js";

/** @typedef {ReturnType<typeof import("../assembly/store.js").assemblyStore>} Store */
/** @typedef {import("../identity/permissions.js").Grant} Grant */
/** @typedef {import("../identity/permissions.js").Scope} Scope */
export const kinds = [
  "units",
  "parts",
  "material",
  "shipments",
  "pallets",
  "baskets",
  "finished",
  "suppliers",
];
export const traceModes = {
  "stored-replacement": "units",
  "in-line": "units",
  defective: "parts",
  "material-carton": "material",
  "material-lot": "material",
  "finished-carton": "finished",
};
const limit = 51;

/** @param {Store} store @param {Grant} grant @param {string} mode */
function unitMode(store, grant, mode) {
  if (mode === "in-line")
    return [
      { $match: { state: "allocated", basketId: { $exists: true } } },
      {
        $lookup: {
          from: store.baskets.collectionName,
          localField: "unitKey",
          foreignField: "unitId",
          as: "baskets",
        },
      },
      { $match: { "baskets.status": "received" } },
      {
        $lookup: {
          from: store.final.collectionName,
          localField: "_id",
          foreignField: "_id",
          as: "final",
        },
      },
      { $match: { "final.status": { $nin: ["passed", "packed"] } } },
    ];
  if (mode === "stored-replacement")
    return [
      { $match: { state: "allocated" } },
      {
        $lookup: {
          from: store.parts.collectionName,
          localField: "unitKey",
          foreignField: "unitId",
          pipeline: [
            {
              $match: {
                replacesPartId: { $exists: true },
                installedAt: { $exists: true },
              },
            },
            { $set: { "scope.warehouseId": "$warehouseId" } },
            { $match: scopeQuery(grant) },
            { $limit: 1 },
            { $project: { _id: 1 } },
          ],
          as: "replacement",
        },
      },
      { $match: { "replacement.0": { $exists: true } } },
      {
        $lookup: {
          from: store.finishedCartons.collectionName,
          localField: "unitKey",
          foreignField: "members.unitId",
          pipeline: [
            { $match: { status: "placed", ...scopeQuery(grant) } },
            { $limit: 1 },
            { $project: { _id: 1 } },
          ],
          as: "stored",
        },
      },
      { $match: { "stored.0": { $exists: true } } },
    ];
  return [];
}
/** @param {Store} store @param {Grant} grant @param {string} mode */
function sources(store, grant, mode) {
  const scope = scopeQuery(grant);
  return {
    units: store.imei.units.aggregate([
      { $match: scope },
      { $set: { unitKey: { $toString: "$_id" } } },
      ...unitMode(store, grant, mode),
      {
        $lookup: {
          from: store.imei.history.collectionName,
          localField: "unitKey",
          foreignField: "entityId",
          as: "history",
        },
      },
      {
        $project: {
          code: 1,
          numbers: 1,
          previous: "$history.detail.numbers",
          title: "$modelName",
          status: "$state",
        },
      },
    ]),
    parts: store.parts.aggregate([
      ...(mode === "defective"
        ? [
            {
              $match: {
                state: {
                  $in: ["defective", "defect_store", "supplier_return"],
                },
              },
            },
          ]
        : []),
      { $set: { "scope.warehouseId": "$warehouseId" } },
      { $match: scope },
      {
        $project: {
          code: 1,
          title: "$skuCode",
          status: "$state",
          cartonCode: 1,
        },
      },
    ]),
    baskets: store.baskets.aggregate([
      { $match: scope },
      { $project: { code: 1, title: "$modelName", status: 1 } },
    ]),
    shipments: store.shipments.aggregate([
      { $match: scope },
      {
        $project: {
          code: 1,
          title: "$supplierName",
          status: 1,
          waybillNumber: 1,
        },
      },
    ]),
    finished: store.finishedCartons.aggregate([
      { $match: scope },
      {
        $project: {
          code: 1,
          title: "$modelName",
          status: 1,
          numbers: "$members.numbers",
        },
      },
    ]),
  };
}
/** @param {Store} store @param {Grant} grant @param {string} kind @param {RegExp|null} query @param {number} skip @param {number} size @param {{mode?:string,partTypeId?:string}} [options] */
export async function searchTrace(
  store,
  grant,
  kind,
  query,
  skip,
  size,
  { mode = "", partTypeId } = {},
) {
  const scope = scopeQuery(grant, ["shipment.scope"]);
  const parent = store.shipments.collectionName;
  const children = [
    { $set: { shipmentKey: { $toObjectId: "$shipmentId" } } },
    {
      $lookup: {
        from: parent,
        localField: "shipmentKey",
        foreignField: "_id",
        as: "shipment",
      },
    },
    { $unwind: "$shipment" },
    { $match: scope },
  ];
  const cursors = sources(store, grant, mode);
  const supplierView = store.shipments.aggregate([
    { $match: scopeQuery(grant) },
    {
      $group: {
        _id: { $toObjectId: "$supplierId" },
        title: { $first: "$supplierName" },
      },
    },
    {
      $lookup: {
        from: store.catalog.records.collectionName,
        localField: "_id",
        foreignField: "_id",
        as: "catalog",
      },
    },
    { $project: { title: 1, code: { $first: "$catalog.code" } } },
  ]);
  const selected = kind === "all" ? kinds : [kind];
  const skus = partTypeId
    ? await store.catalog.records
        .find(
          { kind: "skus", "data.partTypeId": partTypeId },
          { projection: { _id: 1 } },
        )
        .map((row) => String(row._id))
        .toArray()
    : null;
  const found = await Promise.all(
    selected.map(async (entity) => {
      const cursor =
        entity === "material"
          ? store.cartons.aggregate([
              ...(mode === "material-lot"
                ? [{ $match: { lot: { $type: "string", $ne: "" } } }]
                : []),
              ...(skus ? [{ $match: { skuId: { $in: skus } } }] : []),
              ...children,
              {
                $project: {
                  code: 1,
                  title: "$skuCode",
                  status: "$state",
                  lot: 1,
                },
              },
            ])
          : entity === "pallets"
            ? store.pallets.aggregate([
                ...children,
                { $project: { code: 1, title: "$shipment.code" } },
              ])
            : entity === "suppliers"
              ? supplierView
              : cursors[/** @type {keyof typeof cursors} */ (entity)];
      const [out] = await cursor
        .match(
          query
            ? {
                $or: [
                  { code: query },
                  { numbers: query },
                  { previous: query },
                  { title: query },
                  { lot: query },
                  { waybillNumber: query },
                ],
              }
            : {},
        )
        .addStage({
          $facet: {
            items: [{ $sort: { _id: -1 } }, { $skip: skip }, { $limit: size }],
            count: [{ $count: "value" }],
          },
        })
        .toArray();
      return {
        kind: entity,
        items: (out?.items ?? []).map(publicRow),
        count: out?.count[0]?.value ?? 0,
      };
    }),
  );
  return found;
}

/** @param {Store} store @param {Grant} grant @param {string} kind @param {unknown} value */
export async function traceDetail(store, grant, kind, value) {
  const id = objectId(value),
    key = String(id);
  const scope = scopeQuery(grant);
  const allow = (/** @type {Scope} */ resource) =>
    hasPermission(grant, "trace:view", resource);
  if (
    kind === "units" &&
    !(await store.imei.units.findOne({ _id: id, ...scope }))
  )
    throw missing();
  if (
    kind === "parts" &&
    !(await store.parts.findOne({
      _id: id,
      ...scopeQuery(grant, ["scope"]),
    })) &&
    !(await store.parts
      .aggregate([
        { $match: { _id: id } },
        { $set: { "scope.warehouseId": "$warehouseId" } },
        { $match: scope },
      ])
      .hasNext())
  )
    throw missing();
  if (
    kind === "baskets" &&
    !(await store.baskets.findOne({ _id: id, ...scope }))
  )
    throw missing();
  if (
    kind === "finished" &&
    !(await store.finishedCartons.findOne({ _id: id, ...scope }))
  )
    throw missing();
  if (
    kind === "shipments" &&
    !(await store.shipments.findOne({ _id: id, ...scope }))
  )
    throw missing();
  const material =
    kind === "material" ? await store.cartons.findOne({ _id: id }) : null;
  const pallet =
    kind === "pallets" ? await store.pallets.findOne({ _id: id }) : null;
  if (kind === "material" || kind === "pallets") {
    const shipmentId = material?.shipmentId ?? pallet?.shipmentId;
    if (
      !shipmentId ||
      !(await store.shipments.findOne({ _id: objectId(shipmentId), ...scope }))
    )
      throw missing();
  }
  const shipmentFilter =
    kind === "shipments"
      ? { _id: id }
      : kind === "suppliers"
        ? { supplierId: key }
        : null;
  const selectedShipments = shipmentFilter
    ? await store.shipments
        .find({ ...shipmentFilter, ...scope })
        .sort({ _id: -1 })
        .limit(limit)
        .toArray()
    : [];
  if (kind === "suppliers" && !selectedShipments.length) throw missing();
  const originCartons = material
    ? [material]
    : kind === "pallets"
      ? await store.cartons.find({ palletId: key }).limit(limit).toArray()
      : selectedShipments.length
        ? await store.cartons
            .find({
              shipmentId: {
                $in: selectedShipments.map((row) => String(row._id)),
              },
            })
            .limit(limit)
            .toArray()
        : [];
  const finished =
    kind === "finished"
      ? await store.finishedCartons.findOne({ _id: id, ...scope })
      : null;
  const basket =
    kind === "baskets"
      ? await store.baskets.findOne({ _id: id, ...scope })
      : null;
  const part = kind === "parts" ? await store.parts.findOne({ _id: id }) : null;
  const relatedParts = originCartons.length
    ? await store.parts
        .find({
          cartonId: { $in: originCartons.map((row) => String(row._id)) },
        })
        .limit(limit)
        .toArray()
    : [];
  const unitKeys = [
    ...new Set([
      ...(kind === "units" ? [key] : []),
      ...(part ? [part.unitId] : []),
      ...(basket ? [basket.unitId] : []),
      ...(finished?.members.map((row) => row.unitId) ?? []),
      ...relatedParts
        .filter((row) => allow({ ...row.scope, warehouseId: row.warehouseId }))
        .map((row) => row.unitId),
    ]),
  ];
  const units = await store.imei.units
    .find({ _id: { $in: unitKeys.map(objectId) }, ...scope })
    .limit(limit)
    .toArray();
  const unitIds = units.map((row) => String(row._id));
  const parts = (
    await store.parts
      .find({
        $or: [
          { unitId: { $in: unitIds } },
          {
            _id: {
              $in: [
                ...(part
                  ? [
                      part._id,
                      ...(part.replacesPartId
                        ? [objectId(part.replacesPartId)]
                        : []),
                    ]
                  : []),
                ...relatedParts.map((row) => row._id),
              ],
            },
          },
          { replacesPartId: key },
        ],
      })
      .sort({ _id: -1 })
      .limit(limit)
      .toArray()
  ).filter((row) => allow({ ...row.scope, warehouseId: row.warehouseId }));
  const cartonIds = [
    ...new Set([
      ...originCartons.map((row) => String(row._id)),
      ...parts.map((row) => row.cartonId),
    ]),
  ];
  const cartons = await store.cartons
    .find({ _id: { $in: cartonIds.map(objectId) } })
    .limit(limit)
    .toArray();
  const shipments = await store.shipments
    .find({
      _id: {
        $in: [
          ...new Set([
            ...cartons.map((row) => row.shipmentId),
            ...selectedShipments.map((row) => String(row._id)),
            ...(pallet ? [pallet.shipmentId] : []),
          ]),
        ].map(objectId),
      },
      ...scope,
    })
    .limit(limit)
    .toArray();
  const allowedShipments = new Set(shipments.map((row) => String(row._id)));
  const visibleCartons = cartons.filter((row) =>
    allowedShipments.has(row.shipmentId),
  );
  const [baskets, visits, results, finalChecks, master, ledger] =
    await Promise.all([
      store.baskets
        .find({ unitId: { $in: unitIds }, ...scope })
        .limit(limit)
        .toArray(),
      store.visits
        .find({ unitId: { $in: unitIds }, ...scope })
        .sort({ entryAt: 1 })
        .limit(limit)
        .toArray(),
      store.results
        .find({ unitId: { $in: unitIds }, ...scope })
        .sort({ at: 1 })
        .limit(limit)
        .toArray(),
      store.finalChecks
        .find({ unitId: { $in: unitIds } })
        .sort({ at: 1 })
        .limit(limit)
        .toArray(),
      store.finishedCartons
        .find({
          $and: [
            scope,
            {
              $or: [
                { "members.unitId": { $in: unitIds } },
                ...(finished ? [{ _id: finished._id }] : []),
              ],
            },
          ],
        })
        .limit(limit)
        .toArray(),
      store.ledger
        .find({
          $and: [
            scopeQuery(grant, ["scope", "fromScope"]),
            {
              $or: [
                { partId: { $in: parts.map((row) => String(row._id)) } },
                {
                  cartonId: {
                    $in: visibleCartons.map((row) => String(row._id)),
                  },
                },
              ],
            },
          ],
        })
        .sort({ at: 1 })
        .limit(limit)
        .toArray(),
    ]);
  const [defects, returns, pallets, custody] = await Promise.all([
    store.defects
      .find({
        $and: [
          scope,
          {
            $or: [
              { visitId: { $in: visits.map((row) => String(row._id)) } },
              { partId: { $in: parts.map((row) => String(row._id)) } },
            ],
          },
        ],
      })
      .limit(limit)
      .toArray(),
    store.returns
      .find({
        "parts.id": { $in: parts.map((row) => String(row._id)) },
        ...scope,
      })
      .limit(limit)
      .toArray(),
    store.pallets
      .find({
        shipmentId: { $in: [...allowedShipments] },
        $or: [
          { _id: { $in: visibleCartons.map((row) => objectId(row.palletId)) } },
          ...(pallet ? [{ _id: pallet._id }] : []),
        ],
      })
      .limit(limit)
      .toArray(),
    store.custody
      .find({
        _id: { $in: parts.map((row) => objectId(row.custodyId)) },
        ...scopeQuery(grant, ["warehouseScope", "lineScope"]),
      })
      .limit(limit)
      .toArray(),
  ]);
  const requestIds = [...new Set(custody.map((row) => row.requestId))].map(
    objectId,
  );
  const requests = await store.requests
    .find({
      _id: { $in: requestIds },
      ...scopeQuery(grant, ["warehouseScope", "lineScope"]),
    })
    .limit(limit)
    .toArray();
  const deliveries = await store.deliveries
    .find({
      _id: {
        $in: custody
          .filter((row) =>
            requests.some((req) => String(req._id) === row.requestId),
          )
          .map((row) => objectId(row.deliveryId)),
      },
    })
    .limit(limit)
    .toArray();
  const [history, finalRejections] = await Promise.all([
    store.imei.history
      .find({ entityId: { $in: unitIds }, ...scope })
      .sort({ at: 1 })
      .limit(limit)
      .toArray(),
    store.finalRejections
      .find({ unitId: { $in: unitIds } })
      .sort({ at: 1 })
      .limit(limit)
      .toArray(),
  ]);
  const actorIds = [
    ...new Set(
      [
        ...ledger.map((row) => row.actorId),
        ...results.map((row) => row.actorId),
        ...finalChecks.map((row) => row.actorId),
        ...history.map((row) => row.actorId),
        ...visits.flatMap((row) => [
          row.enteredBy,
          row.completedBy,
          row.exitedBy,
        ]),
        ...deliveries.flatMap((row) => [row.issuerId, row.receiverId]),
        ...defects.map((row) => row.actorId),
        ...returns.flatMap((row) => row.events.map((event) => event.actorId)),
      ]
        .filter((id) => id && /^[a-f0-9]{24}$/i.test(id))
        .map(objectId),
    ),
  ];
  const users = await identityStore(store.database)
    .users.find({ _id: { $in: actorIds } }, { projection: { name: 1 } })
    .toArray();
  return {
    actors: Object.fromEntries(users.map((row) => [String(row._id), row.name])),
    history: history.map(publicRow),
    finalRejections: finalRejections.map(publicRow),
    units: units.map((row) => ({
      id: String(row._id),
      code: row.code,
      numbers: row.numbers,
      modelName: row.modelName,
      lineName: row.lineName,
      orderCode: row.orderCode,
      at: row.at,
      qcPassedAt: row.qcPassedAt,
      hamtaStatus: row.hamtaStatus,
    })),
    parts: parts.map(publicPart),
    baskets: baskets.map(publicRow),
    visits: visits.map(publicRow),
    results: results.map(publicRow),
    finalChecks: finalChecks.map(publicRow),
    finished: master.map(publicRow),
    material: visibleCartons.map((row) => ({
      ...publicRow(row),
      quantity: row.quantity.toString(),
    })),
    shipments: shipments.map((row) => ({
      id: String(row._id),
      code: row.code,
      supplierName: row.supplierName,
      supplierId: row.supplierId,
      createdAt: row.createdAt,
      waybillNumber: row.waybillNumber,
      status: row.status,
    })),
    pallets: pallets.map(publicRow),
    ledger: ledger.map((row) => ({
      id: row._id,
      documentType: row.documentType,
      from: row.from,
      to: row.to,
      quantity: row.quantity.toString(),
      at: row.at,
      actorId: row.actorId,
    })),
    defects: defects.map(publicRow),
    returns: returns.map(publicRow),
    requests: requests.map((row) => ({
      id: String(row._id),
      code: row.code,
      status: row.status,
      at: row.at,
      actorId: row.actorId,
    })),
    deliveries: deliveries.map(publicRow),
  };
}
