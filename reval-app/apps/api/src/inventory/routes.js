import express from "express";
import { Decimal128 } from "mongodb";
import { catalogStore } from "../catalog/store.js";
import { idText } from "../catalog/validation.js";
import { finishedCollections } from "../finished/store.js";
import { ApiError } from "../http-error.js";
import { publicCustody } from "../handover/store.js";
import { appendAudit } from "../identity/audit.js";
import { requirePermission } from "../identity/permissions.js";
import { badInput, objectId, pageInput } from "../identity/validation.js";
import { amountText, minor } from "./amounts.js";
import {
  adjustBalance,
  loadBalance,
  moveCarton,
  movePallet,
  publicBalance,
  publicLedger,
  publicReservation,
  release,
  reserve,
} from "./commands.js";
import {
  balancePipeline,
  filterSearch,
  groupedStock,
  reconcile,
  scopeQuery,
} from "./queries.js";
import { inventoryStore } from "./store.js";

/** @typedef {Awaited<ReturnType<typeof import("../identity/sessions.js").identify>>} Actor */
/** @typedef {ReturnType<typeof import("../identity/store.js").identityStore>} IdentityStore */
/** @typedef {import("../identity/permissions.js").Scope} Scope */
/** @typedef {import("../shipments/store.js").Balance} Balance */
/** @typedef {import("./store.js").Custody} Custody */
/** @typedef {import("express").Request} Request */
/** @typedef {import("express").Response} Response */
/** @typedef {import("mongodb").ClientSession} Session */
/** @typedef {{ actor: import("../identity/store.js").User | null, module: string, action: string, correlationId: string }} AuditContext */
/** @typedef {(actor:Actor, request:Request, session:Session, authorize:(scope:Scope)=>void)=>Promise<object>} Mutation */

/** @param {Response} response @param {unknown} result @param {number} [status] */
const reply = (response, result, status = 200) =>
  response.status(status).json({ statusCode: status, message: "موفق", result });
/** @param {Actor} actor @param {string} action */
function modulePermission(actor, action) {
  if (!actor.grant.permissions.includes("inventory:" + action))
    requirePermission(actor.grant, "inventory:" + action);
}

/** @param {Actor} actor @param {string|undefined} warehouseId @param {RegExp|undefined} q @param {unknown} account */
function custodyFilter(actor, warehouseId, q, account) {
  const zero = Decimal128.fromString("0");
  /** @type {import("mongodb").Filter<Custody>[]} */
  const conditions = [scopeQuery(actor.grant, ["warehouseScope", "lineScope"])];
  if (account === "transit") conditions.push({ transit: { $gt: zero } });
  else {
    const production = [{ line: { $gt: zero } }, { basket: { $gt: zero } }];
    conditions.push({
      $or:
        account === "production"
          ? production
          : [{ transit: { $gt: zero } }, ...production],
    });
  }
  if (warehouseId) conditions.push({ warehouseId });
  if (q) conditions.push({ $or: [{ cartonCode: q }, { skuCode: q }] });
  return { $and: conditions };
}

/** @param {ReturnType<typeof catalogStore>} catalog @param {Custody[]} rows */
async function custodyViews(catalog, rows) {
  if (!rows.length) return [];
  const lines = await catalog.records
    .find({
      kind: "lines",
      _id: { $in: [...new Set(rows.map((row) => row.lineId))].map(objectId) },
    })
    .toArray();
  const names = new Map(lines.map((row) => [String(row._id), row.name]));
  return rows.map((row) => ({
    ...publicCustody(row),
    lineName: names.get(row.lineId) ?? row.lineId,
  }));
}

/** @param {IdentityStore} identity @param {(request:Request,response:Response)=>Promise<Actor>} authenticate @param {(response:Response,module:string,action:string)=>AuditContext} event */
export function inventoryRouter(identity, authenticate, event) {
  const store = inventoryStore(identity.database);
  const catalog = catalogStore(identity.database);
  const router = express.Router();

  router.get("/options", async (request, response) => {
    const actor = await authenticate(request, response);
    modulePermission(actor, "view");
    const rows = await catalog.records
      .find({
        ...scopeQuery(actor.grant),
        kind: { $in: ["warehouses", "locations"] },
        active: true,
      })
      .sort({ code: 1, _id: 1 })
      .toArray();
    const locationIds = rows
      .filter((row) => row.kind === "locations")
      .map((row) => String(row._id));
    const placement =
      request.query.map === "true"
        ? await store.balances
            .aggregate([
              {
                $match: {
                  $and: [
                    scopeQuery(actor.grant),
                    {
                      account: "storage",
                      locationId: { $in: locationIds },
                      quantity: { $gt: 0 },
                    },
                  ],
                },
              },
              { $sort: { skuId: 1 } },
              {
                $group: {
                  _id: "$locationId",
                  cartons: { $sum: 1 },
                  skuId: { $first: "$skuId" },
                },
              },
              { $set: { skuKey: { $toObjectId: "$skuId" } } },
              {
                $lookup: {
                  from: catalog.records.collectionName,
                  localField: "skuKey",
                  foreignField: "_id",
                  as: "sku",
                },
              },
              { $project: { cartons: 1, skuCode: { $first: "$sku.code" } } },
            ])
            .toArray()
        : [];
    const locations = new Map(
      placement.map((row) => [
        row._id,
        { cartons: row.cartons, skuCode: row.skuCode },
      ]),
    );
    const choices = rows.map((item) => ({
      id: String(item._id),
      kind: item.kind,
      code: item.code,
      name: item.name,
      parentId: item.parentId,
      purpose: item.kind === "warehouses" ? item.data.purpose : undefined,
      placement: locations.get(String(item._id)),
    }));
    reply(response, choices);
  });

  router.get(
    [
      "/balances",
      "/summary",
      "/pallets",
      "/balances/export",
      "/carton-stock",
      "/carton-stock/export",
    ],
    async (request, response) => {
      const actor = await authenticate(request, response);
      modulePermission(actor, "view");
      const exporting = request.path.endsWith("/export");
      if (exporting) modulePermission(actor, "pdf");
      const cartons = request.path.startsWith("/carton-stock");
      const account = request.query.account;
      const materials = cartons && request.query.zone === "materials";
      const custodyOnly =
        cartons && (account === "transit" || account === "production");
      /** @type {import("mongodb").Document} */
      const filter = scopeQuery(actor.grant);
      if (request.query.warehouseId)
        filter.warehouseId = idText(request.query.warehouseId);
      if (request.query.locationId)
        filter.locationId = idText(request.query.locationId);
      if (account && !custodyOnly) {
        if (
          typeof account !== "string" ||
          !["receiving", "storage", "quarantine"].includes(account)
        ) {
          throw new ApiError(400, "INVALID_ACCOUNT", "حساب موجودی معتبر نیست.");
        }
        filter.account = account;
      }
      if (materials && !account)
        filter.account = { $in: ["receiving", "storage"] };
      if (materials && account === "quarantine") throw badInput();
      const search = request.query.q
        ? filterSearch(request.query.q)
        : undefined;
      const group = request.path.slice(1);
      /** @type {import("mongodb").Document[]} */
      const custody = [
        {
          $match: {
            ...custodyFilter(actor, filter.warehouseId, search, account),
            ...(filter.locationId ? { _id: { $exists: false } } : {}),
          },
        },
        { $set: { stockSource: "custody" } },
      ];
      /** @type {import("mongodb").Document[]} */
      const base = custodyOnly
        ? custody
        : balancePipeline(filter, group === "pallets" ? undefined : search);
      if (cartons && !account && !filter.locationId) {
        base.push({
          $unionWith: { coll: store.custody.collectionName, pipeline: custody },
        });
      }
      const pipeline =
        group === "summary" || group === "pallets"
          ? groupedStock(base, group)
          : base;
      if (group === "pallets" && search) {
        pipeline.push({
          $match: {
            $or: [{ code: search }, { locations: search }, { source: search }],
          },
        });
      }
      const { skip, size } = pageInput(request.query);
      const source = custodyOnly ? store.custody : store.balances;
      const [result] = await source
        .aggregate([
          ...pipeline,
          {
            $facet: {
              data: [
                {
                  $sort:
                    group === "pallets"
                      ? { code: 1, _id: 1 }
                      : group === "summary"
                        ? { skuCode: 1, _id: 1 }
                        : { cartonCode: 1, _id: 1 },
                },
                { $skip: skip },
                { $limit: size },
              ],
              count: [{ $count: "value" }],
            },
          },
        ])
        .toArray();
      const rows = result?.data ?? [];
      const custodyById = new Map(
        (
          await custodyViews(
            catalog,
            rows.filter(
              (/** @type {import("mongodb").Document} */ row) =>
                row.stockSource === "custody",
            ),
          )
        ).map((row) => [row.id, row]),
      );
      const data = rows.map((/** @type {import("mongodb").Document} */ row) => {
        if (row.stockSource === "custody")
          return {
            ...custodyById.get(String(row._id)),
            stockSource: "custody",
          };
        if (group === "summary") {
          const { _id, ...rest } = row;
          return Object.fromEntries(
            Object.entries({ ..._id, ...rest }).map(([key, item]) => [
              key,
              item instanceof Decimal128
                ? amountText(minor(item.toString()))
                : item,
            ]),
          );
        }
        if (group === "pallets") {
          const { _id, ...rest } = row;
          return { id: _id, ...rest };
        }
        return publicBalance(/** @type {Balance} */ (row));
      });
      if (exporting)
        await appendAudit(
          identity,
          event(response, "inventory", "inventory.export"),
          { result: "success" },
        );
      reply(response, { data, count: result?.count[0]?.value ?? 0 });
    },
  );

  router.get("/warehouse-stock/:kind", async (request, response) => {
    const kind = request.params.kind;
    if (kind !== "defects" && kind !== "finished") throw badInput();
    const exporting = request.query.print === "true";
    const actor = await authenticate(request, response);
    modulePermission(actor, "view");
    if (!actor.grant.permissions.includes(kind + ":view"))
      requirePermission(actor.grant, kind + ":view");
    if (exporting) {
      modulePermission(actor, "pdf");
      if (!actor.grant.permissions.includes(kind + ":pdf"))
        requirePermission(actor.grant, kind + ":pdf");
    }
    const warehouseId = request.query.warehouseId
      ? idText(request.query.warehouseId)
      : undefined;
    const q = request.query.q ? filterSearch(request.query.q) : undefined;
    const { skip, size } = pageInput(request.query);
    const defects = kind === "defects";
    const source = defects
      ? store.parts
      : finishedCollections(identity.database).finishedCartons;
    const scope = scopeQuery(actor.grant);
    const pipeline = defects
      ? [
          {
            $match: {
              state: "defect_store",
              ...(warehouseId ? { warehouseId } : {}),
              ...(q
                ? { $or: [{ code: q }, { skuCode: q }, { cartonCode: q }] }
                : {}),
            },
          },
          { $set: { "scope.warehouseId": "$warehouseId" } },
          { $match: scope },
          {
            $project: {
              code: 1,
              description: "$skuCode",
              sourceCarton: "$cartonCode",
              warehouseId: 1,
              quantity: 1,
            },
          },
        ]
      : [
          {
            $match: {
              $and: [
                scope,
                { status: "placed" },
                warehouseId ? { "scope.warehouseId": warehouseId } : {},
                q
                  ? {
                      $or: [
                        { code: q },
                        { modelName: q },
                        { locationName: q },
                        { "members.numbers": q },
                      ],
                    }
                  : {},
              ],
            },
          },
          {
            $project: {
              code: 1,
              description: "$modelName",
              locationName: 1,
              warehouseId: "$scope.warehouseId",
              quantity: { $size: "$members" },
            },
          },
        ];
    const [result] = await source
      .aggregate([
        ...pipeline,
        {
          $facet: {
            data: [{ $sort: { _id: -1 } }, { $skip: skip }, { $limit: size }],
            count: [{ $count: "value" }],
          },
        },
      ])
      .toArray();
    const data = (result?.data ?? []).map(
      (
        /** @type {import("mongodb").Document} */ { _id, quantity, ...row },
      ) => ({
        id: String(_id),
        ...row,
        quantity: defects
          ? amountText(minor(quantity.toString()))
          : String(quantity),
      }),
    );
    if (exporting)
      await appendAudit(
        identity,
        event(response, "inventory", "inventory.export"),
        {
          result: "success",
        },
      );
    reply(response, { data, count: result?.count[0]?.value ?? 0 });
  });

  router.get("/custody", async (request, response) => {
    const actor = await authenticate(request, response);
    modulePermission(actor, "view");
    const { skip, size } = pageInput(request.query);
    const filter = custodyFilter(
      actor,
      request.query.warehouseId ? idText(request.query.warehouseId) : undefined,
      request.query.q ? filterSearch(request.query.q) : undefined,
      undefined,
    );
    const [rows, count] = await Promise.all([
      store.custody
        .find(filter)
        .sort({ _id: -1 })
        .skip(skip)
        .limit(size)
        .toArray(),
      store.custody.countDocuments(filter),
    ]);
    reply(response, {
      data: await custodyViews(catalog, rows),
      count,
    });
  });

  router.get("/ledger", async (request, response) => {
    const actor = await authenticate(request, response);
    modulePermission(actor, "view");
    const { skip, size } = pageInput(request.query);
    /** @type {import("mongodb").Filter<import("../shipments/store.js").Ledger>[]} */
    const and = [scopeQuery(actor.grant, ["scope", "fromScope"])];
    if (request.query.cartonId)
      and.push({ cartonId: idText(request.query.cartonId) });
    if (request.query.warehouseId) {
      const warehouseId = idText(request.query.warehouseId);
      and.push({ $or: [{ warehouseId }, { fromWarehouseId: warehouseId }] });
    }
    if (request.query.adjustments === "true")
      and.push({ documentType: "inventory.adjustment" });
    const filter = { $and: and };
    const [data, count] = await Promise.all([
      store.ledger
        .find(filter)
        .sort({ at: -1, _id: -1 })
        .skip(skip)
        .limit(size)
        .toArray(),
      store.ledger.countDocuments(filter),
    ]);
    const reversals = await store.ledger
      .find(
        { reversesId: { $in: data.map((row) => row._id) } },
        { projection: { reversesId: 1 } },
      )
      .toArray();
    const reversed = new Set(reversals.map((row) => row.reversesId));
    reply(response, {
      data: data.map((row) => ({
        ...publicLedger(row),
        reversed: reversed.has(row._id),
      })),
      count,
    });
  });

  router.get("/cartons/:id", async (request, response) => {
    const actor = await authenticate(request, response);
    const balance = await loadBalance(store, idText(request.params.id));
    requirePermission(actor.grant, "inventory:view", balance.scope);
    const carton = await store.cartons.findOne({
      _id: objectId(balance.cartonId),
    });
    reply(response, {
      ...publicBalance(balance),
      cartonCode: carton?.code ?? balance.cartonId,
    });
  });

  router.get("/cartons/:id/reservations", async (request, response) => {
    const actor = await authenticate(request, response);
    const balance = await loadBalance(store, idText(request.params.id));
    requirePermission(actor.grant, "inventory:view", balance.scope);
    const reservations = await store.reservations
      .find({ cartonId: balance.cartonId, state: "active" })
      .sort({ at: 1 })
      .toArray();
    reply(response, reservations.map(publicReservation));
  });

  router.get("/cartons/:id/reconciliation", async (request, response) => {
    const actor = await authenticate(request, response);
    const result = await identity.database.transaction(async (session) => {
      const balance = await loadBalance(
        store,
        idText(request.params.id),
        session,
      );
      requirePermission(actor.grant, "inventory:view", balance.scope);
      return reconcile(store, balance, session);
    });
    reply(response, result);
  });

  /** @param {string} action @param {string} permission @param {Mutation} handler @returns {import("express").RequestHandler} */
  function mutate(action, permission, handler) {
    return async (request, response) => {
      event(response, "inventory", action);
      const actor = await authenticate(request, response);
      modulePermission(actor, permission);
      if (permission === "edit" && actor.role._id !== "whManager") {
        throw new ApiError(
          403,
          "WAREHOUSE_MANAGER_REQUIRED",
          "اصلاح موجودی فقط با تأیید مدیر انبار انجام می‌شود.",
        );
      }
      const context = event(response, "inventory", action);
      const result = await identity.database.transaction(async (session) => {
        const value = await handler(actor, request, session, (scope) =>
          requirePermission(actor.grant, "inventory:" + permission, scope),
        );
        await appendAudit(
          identity,
          context,
          {
            result: "success",
            entityId: idText(request.params.id),
            after: value,
          },
          session,
        );
        return value;
      });
      reply(response, result, 201);
    };
  }

  router.post(
    "/cartons/:id/moves",
    mutate("carton.move", "transfer", (actor, request, session, authorize) =>
      moveCarton(
        store,
        catalog,
        idText(request.params.id),
        request.body,
        String(actor.user._id),
        session,
        authorize,
      ),
    ),
  );
  router.post(
    "/pallets/:id/moves",
    mutate("pallet.move", "transfer", (actor, request, session, authorize) =>
      movePallet(
        store,
        catalog,
        idText(request.params.id),
        request.body,
        String(actor.user._id),
        session,
        authorize,
      ),
    ),
  );
  router.post(
    "/cartons/:id/adjustments",
    mutate(
      "stock.adjust",
      "edit",
      async (actor, request, session, authorize) => {
        const balance = await loadBalance(
          store,
          idText(request.params.id),
          session,
        );
        authorize(balance.scope);
        return adjustBalance(
          store,
          catalog,
          balance,
          request.body,
          String(actor.user._id),
          session,
        );
      },
    ),
  );
  router.post(
    "/cartons/:id/reservations",
    mutate(
      "stock.reserve",
      "transfer",
      async (actor, request, session, authorize) => {
        const balance = await loadBalance(
          store,
          idText(request.params.id),
          session,
        );
        authorize(balance.scope);
        return reserve(
          store,
          catalog,
          balance,
          request.body,
          String(actor.user._id),
          session,
        );
      },
    ),
  );
  router.post(
    "/cartons/:id/reservations/:reservationId/release",
    mutate(
      "stock.release",
      "transfer",
      async (actor, request, session, authorize) => {
        const balance = await loadBalance(
          store,
          idText(request.params.id),
          session,
        );
        authorize(balance.scope);
        return release(
          store,
          balance,
          objectId(request.params.reservationId),
          request.body,
          String(actor.user._id),
          session,
        );
      },
    ),
  );
  return router;
}
