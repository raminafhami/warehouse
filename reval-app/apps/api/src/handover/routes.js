import { createHash } from "node:crypto";
import express from "express";
import { catalogStore } from "../catalog/store.js";
import { ApiError } from "../http-error.js";
import { appendAudit } from "../identity/audit.js";
import { hasPermission } from "../identity/permissions.js";
import { objectId, pageInput } from "../identity/validation.js";
import { publicBalance } from "../inventory/commands.js";
import {
  balancePipeline,
  filterSearch,
  scopeQuery,
} from "../inventory/queries.js";
import {
  issueDelivery,
  loadDelivery,
  receiveDelivery,
  returnDelivery,
} from "./deliveries.js";
import {
  activeRequestReservations,
  cancelRequest,
  conflict,
  createRequest,
  invalid,
  loadRequest,
  releaseCarton,
  reserveCarton,
} from "./requests.js";
import {
  handoverStore,
  publicCustody,
  publicDelivery,
  publicRequest,
} from "./store.js";

/** @typedef {Awaited<ReturnType<typeof import("../identity/sessions.js").identify>>} Actor */
/** @typedef {ReturnType<typeof import("../identity/store.js").identityStore>} IdentityStore */
/** @typedef {import("../identity/permissions.js").Scope} Scope */
/** @typedef {import("./store.js").MaterialRequest} MaterialRequest */
/** @typedef {import("express").Request} Request */
/** @typedef {import("express").Response} Response */
/** @typedef {import("mongodb").ClientSession} Session */
/** @typedef {{actor:import("../identity/store.js").User|null,module:string,action:string,correlationId:string}} AuditContext */
/** @typedef {{warehouseScope:Scope,lineScope:Scope}} BothScopes */
/** @typedef {"warehouse"|"line"|"either"} Side */
/** @typedef {(actor:Actor,request:Request,session:Session)=>Promise<{entityId:string,output:object}>} Command */

const denied = () =>
  new ApiError(403, "FORBIDDEN", "دسترسی به این انبار یا خط مجاز نیست.");
/** @param {Response} response @param {unknown} result @param {number} [status] */
const reply = (response, result, status = 200) =>
  response.status(status).json({ statusCode: status, message: "موفق", result });
/** @param {string} value */
const hash = (value) => createHash("sha256").update(value).digest("hex");

/** @param {BothScopes} row */
export function combined(row) {
  return row.warehouseScope.branchId === row.lineScope.branchId
    ? { ...row.warehouseScope, ...row.lineScope }
    : null;
}

/** @param {Actor} actor @param {string} action @param {BothScopes} row @param {Side} side */
function allowed(actor, action, row, side) {
  const name = "handover:" + action;
  const joined = combined(row);
  const widePair =
    joined &&
    actor.grant.scopes.some(
      (scope) =>
        scope.warehouseId === joined.warehouseId &&
        scope.lineId === joined.lineId &&
        hasPermission({ ...actor.grant, scopes: [scope] }, name, joined),
    );
  if (widePair) return true;
  return (
    (side !== "line" && hasPermission(actor.grant, name, row.warehouseScope)) ||
    (side !== "warehouse" && hasPermission(actor.grant, name, row.lineScope))
  );
}
/** @param {Actor} actor @param {string} action @param {BothScopes} row @param {Side} side */
function requireSide(actor, action, row, side) {
  if (!allowed(actor, action, row, side)) throw denied();
}
/** @param {Actor} actor @param {string} action */
function permission(actor, action) {
  if (!actor.grant.permissions.includes("handover:" + action)) throw denied();
}

/** @param {IdentityStore} identity @param {(request:Request,response:Response)=>Promise<Actor>} authenticate @param {(response:Response,module:string,action:string)=>AuditContext} event */
export function handoverRouter(identity, authenticate, event) {
  const store = handoverStore(identity.database),
    catalog = catalogStore(identity.database);
  const router = express.Router();
  router.get("/options", async (request, response) => {
    const actor = await authenticate(request, response);
    permission(actor, "create");
    const [entries, models] = await Promise.all([
      catalog.records
        .find({ kind: { $in: ["warehouses", "lines"] }, active: true })
        .sort({ code: 1 })
        .toArray(),
      catalog.records
        .find({ kind: "models", active: true })
        .sort({ code: 1 })
        .toArray(),
    ]);
    const warehouses = entries.filter((entry) => entry.kind === "warehouses");
    const lines = entries.filter((entry) => entry.kind === "lines");
    const pairs = warehouses.flatMap((warehouse) =>
      lines
        .filter((line) => {
          const scopes = {
            warehouseScope: warehouse.scope,
            lineScope: line.scope,
          };
          return (
            allowed(actor, "create", scopes, "either") &&
            (combined(scopes) ||
              (allowed(actor, "create", scopes, "warehouse") &&
                allowed(actor, "create", scopes, "line")))
          );
        })
        .map((line) => ({
          warehouseId: String(warehouse._id),
          lineId: String(line._id),
        })),
    );
    const option = (
      /** @type {import("../catalog/store.js").Entry} */ item,
    ) => ({ id: String(item._id), name: item.name, code: item.code });
    reply(response, {
      warehouses: warehouses
        .filter((item) =>
          pairs.some((pair) => pair.warehouseId === String(item._id)),
        )
        .map(option),
      lines: lines
        .filter((item) =>
          pairs.some((pair) => pair.lineId === String(item._id)),
        )
        .map(option),
      models: pairs.length ? models.map(option) : [],
      pairs,
    });
  });
  router.get(["/requests", "/requests/export"], async (request, response) => {
    const actor = await authenticate(request, response);
    const exporting = request.path.endsWith("/export");
    permission(actor, "view");
    if (exporting) permission(actor, "pdf");
    const paths = ["warehouseScope", "lineScope", "combinedScope"];
    /** @type {import("mongodb").Filter<MaterialRequest>[]} */
    const conditions = [scopeQuery(actor.grant, paths)];
    if (request.query.q) {
      const q = filterSearch(request.query.q);
      conditions.push({
        $or: [{ code: q }, { modelName: q }, { lineName: q }],
      });
    }
    if (request.query.status) {
      const status = request.query.status;
      if (
        status !== "open" &&
        status !== "partial" &&
        status !== "fulfilled" &&
        status !== "cancelled"
      )
        throw invalid("وضعیت درخواست معتبر نیست.");
      conditions.push({ status });
    }
    const { skip, size } = pageInput(request.query);
    const filter = { $and: conditions };
    const [data, count] = await Promise.all([
      store.requests
        .find(filter)
        .sort({ at: -1, _id: -1 })
        .skip(skip)
        .limit(size)
        .toArray(),
      store.requests.countDocuments(filter),
    ]);
    if (exporting)
      await appendAudit(
        identity,
        event(response, "handover", "request.export"),
        { result: "success" },
      );
    reply(response, { data: data.map(publicRequest), count });
  });
  router.get(
    ["/deliveries", "/deliveries/export"],
    async (request, response) => {
      const actor = await authenticate(request, response);
      const exporting = request.path.endsWith("/export");
      permission(actor, "view");
      if (exporting) permission(actor, "pdf");

      const { status, q } = request.query;
      if (
        status &&
        !["issued", "received", "discrepancy", "partial", "returned"].some(
          (value) => value === status,
        )
      )
        throw invalid("وضعیت حواله معتبر نیست.");
      const conditions = [];
      if (status) conditions.push({ "delivery.status": status });
      if (q) {
        const search = filterSearch(q);
        conditions.push({
          $or: [
            { "delivery.code": search },
            { code: search },
            { modelName: search },
            { lineName: search },
          ],
        });
      }

      const { skip, size } = pageInput(request.query);
      const paths = ["warehouseScope", "lineScope", "combinedScope"];
      /** @typedef {{requestCode:string,modelName:string,warehouseName:string,lineName:string,delivery:import("./store.js").Delivery}} DeliveryEntry */
      const [result] = await store.requests
        .aggregate(
          /** @type {import("mongodb").Document[]} */ ([
            { $match: scopeQuery(actor.grant, paths) },
            { $set: { requestId: { $toString: "$_id" } } },
            {
              $lookup: {
                from: store.deliveries.collectionName,
                localField: "requestId",
                foreignField: "requestId",
                as: "delivery",
              },
            },
            { $unwind: "$delivery" },
            ...(conditions.length ? [{ $match: { $and: conditions } }] : []),
            {
              $facet: {
                data: [
                  { $sort: { "delivery.at": -1, "delivery._id": -1 } },
                  { $skip: skip },
                  { $limit: size },
                  {
                    $project: {
                      _id: 0,
                      requestCode: "$code",
                      modelName: 1,
                      warehouseName: 1,
                      lineName: 1,
                      delivery: 1,
                    },
                  },
                ],
                totals: [{ $count: "count" }],
              },
            },
          ]),
        )
        .toArray();
      const data = /** @type {DeliveryEntry[]} */ (result.data);
      if (exporting)
        await appendAudit(
          identity,
          event(response, "handover", "delivery.export"),
          { result: "success" },
        );
      reply(response, {
        data: data.map(({ delivery, ...names }) => ({
          ...publicDelivery(delivery),
          ...names,
        })),
        count: result.totals[0]?.count ?? 0,
      });
    },
  );
  router.get("/requests/:id", async (request, response) => {
    const actor = await authenticate(request, response);
    const row = await loadRequest(store, objectId(request.params.id));
    requireSide(actor, "view", row, "either");
    const requestId = String(row._id);
    const [reservations, deliveries, custody] = await Promise.all([
      activeRequestReservations(store, row),
      store.deliveries.find({ requestId }).sort({ at: -1, _id: -1 }).toArray(),
      store.custody.find({ requestId }).sort({ _id: 1 }).toArray(),
    ]);
    const hasTransfer = allowed(actor, "transfer", row, "warehouse");
    const stock = hasTransfer
      ? await store.balances
          .aggregate([
            ...balancePipeline(
              {
                warehouseId: row.warehouseId,
                account: "storage",
                skuId: { $in: row.needs.map((need) => need.skuId) },
                $expr: { $gt: ["$quantity", "$reserved"] },
              },
              request.query.q ? filterSearch(request.query.q) : undefined,
            ),
            { $sort: { cartonCode: 1 } },
            { $limit: 100 },
          ])
          .toArray()
      : [];
    reply(response, {
      request: publicRequest(row),
      reservations,
      deliveries: deliveries.map(publicDelivery),
      custody: custody.map(publicCustody),
      stock: stock.map((value) =>
        publicBalance(
          /** @type {import("../shipments/store.js").Balance} */ (value),
        ),
      ),
      access: {
        transfer: hasTransfer,
        cancel: allowed(actor, "edit", row, "warehouse"),
        approve: allowed(actor, "approve", row, "line"),
        reject: allowed(actor, "reject", row, "line"),
        actorId: String(actor.user._id),
      },
    });
  });

  /** @param {string} action @param {Command} perform @returns {import("express").RequestHandler} */
  function mutate(action, perform) {
    return async (request, response) => {
      event(response, "handover", action);
      const actor = await authenticate(request, response);
      const context = event(response, "handover", action);
      const key = request.get("Idempotency-Key");
      if (!key || !/^[-a-zA-Z0-9_]{1,128}$/.test(key))
        throw invalid("کلید تکرارناپذیری معتبر نیست.");
      const id = hash(JSON.stringify([String(actor.user._id), action, key]));
      const fingerprint = hash(
        JSON.stringify([request.path, request.body ?? null]),
      );
      const result = await identity.database.transaction(async (session) => {
        const prior = await store.handoverCommands.findOne(
          { _id: id },
          { session },
        );
        if (prior) {
          if (prior.hash !== fingerprint)
            throw conflict(
              "کلید درخواست پیش‌تر با ورودی دیگری استفاده شده است.",
            );
          const requestId =
            action === "request.create"
              ? /** @type {{id:string}} */ (prior.result).id
              : request.path.startsWith("/deliveries/")
                ? (
                    await loadDelivery(
                      store,
                      objectId(request.params.id),
                      session,
                    )
                  ).requestId
                : request.params.id;
          const original = await loadRequest(
            store,
            objectId(requestId),
            session,
          );
          requireSide(actor, "view", original, "either");
          return { output: prior.result, replayed: true };
        }
        const { entityId, output } = await perform(actor, request, session);
        await store.handoverCommands.insertOne(
          { _id: id, hash: fingerprint, result: output, at: new Date() },
          { session },
        );
        await appendAudit(
          identity,
          context,
          { result: "success", entityId, after: output },
          session,
        );
        return { output, replayed: false };
      });
      reply(response, result.output, result.replayed ? 200 : 201);
    };
  }

  router.post(
    "/requests",
    mutate("request.create", async (actor, request, session) => {
      permission(actor, "create");
      const output = await createRequest(
        store,
        request.body,
        String(actor.user._id),
        session,
        (warehouseScope, lineScope) => {
          const scopes = { warehouseScope, lineScope };
          requireSide(actor, "create", scopes, "either");
          if (!combined(scopes)) {
            requireSide(actor, "create", scopes, "warehouse");
            requireSide(actor, "create", scopes, "line");
          }
        },
      );
      return { entityId: output.id, output };
    }),
  );

  /** @param {string} action @param {string} access @param {(row:MaterialRequest,actor:Actor,request:Request,session:Session)=>Promise<object>} perform */
  function changeRequest(action, access, perform) {
    return mutate(action, async (actor, request, session) => {
      const row = await loadRequest(
        store,
        objectId(request.params.id),
        session,
      );
      requireSide(actor, access, row, "warehouse");
      return {
        entityId: String(row._id),
        output: await perform(row, actor, request, session),
      };
    });
  }
  router.post(
    "/requests/:id/reservations",
    changeRequest(
      "request.reserve",
      "transfer",
      (row, actor, request, session) =>
        reserveCarton(
          store,
          row,
          request.body,
          String(actor.user._id),
          session,
        ),
    ),
  );
  router.post(
    "/requests/:id/reservations/:reservationId/release",
    changeRequest(
      "request.release",
      "transfer",
      (row, actor, request, session) =>
        releaseCarton(
          store,
          row,
          objectId(request.params.reservationId),
          request.body,
          String(actor.user._id),
          session,
        ),
    ),
  );
  router.post(
    "/requests/:id/cancel",
    changeRequest("request.cancel", "edit", (row, actor, request, session) =>
      cancelRequest(store, row, request.body, String(actor.user._id), session),
    ),
  );
  router.post(
    "/requests/:id/deliveries",
    changeRequest(
      "delivery.issue",
      "transfer",
      (row, actor, request, session) =>
        issueDelivery(
          store,
          row,
          request.body,
          String(actor.user._id),
          session,
        ),
    ),
  );
  router.post(
    "/deliveries/:id/receipts",
    mutate("delivery.receive", async (actor, request, session) => {
      const delivery = await loadDelivery(
        store,
        objectId(request.params.id),
        session,
      );
      const row = await loadRequest(
        store,
        objectId(delivery.requestId),
        session,
      );
      if (
        !allowed(actor, "approve", row, "line") &&
        !allowed(actor, "reject", row, "line")
      )
        throw denied();
      const output = await receiveDelivery(
        store,
        row,
        delivery,
        request.body,
        String(actor.user._id),
        session,
        (access) => requireSide(actor, access, row, "line"),
      );
      return { entityId: String(delivery._id), output };
    }),
  );
  router.post(
    "/deliveries/:id/returns",
    mutate("delivery.return", async (actor, request, session) => {
      const delivery = await loadDelivery(
        store,
        objectId(request.params.id),
        session,
      );
      const row = await loadRequest(
        store,
        objectId(delivery.requestId),
        session,
      );
      requireSide(actor, "transfer", row, "warehouse");
      const output = await returnDelivery(
        store,
        row,
        delivery,
        request.body,
        String(actor.user._id),
        session,
      );
      return { entityId: String(delivery._id), output };
    }),
  );
  return router;
}
