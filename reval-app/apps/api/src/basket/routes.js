import express from "express";
import bwip from "@bwip-js/node";
import { catalogStore } from "../catalog/store.js";
import { ApiError } from "../http-error.js";
import { appendAudit } from "../identity/audit.js";
import { transactionCommands } from "../identity/commands.js";
import { hasPermission, requirePermission } from "../identity/permissions.js";
import {
  badInput,
  fields,
  objectId,
  pageInput,
} from "../identity/validation.js";
import { amountText, minor } from "../inventory/amounts.js";
import { filterSearch, scopeQuery } from "../inventory/queries.js";
import { publicCustody } from "../handover/store.js";
import { publicRow } from "../imei/store.js";
import { lineOptions } from "../insights/report.js";
import { basketStore } from "./store.js";
import {
  createPartLabel,
  matchingStock,
  publicPart,
  removePart,
  scanPart,
} from "./parts.js";
import {
  advance,
  assertVersion,
  confirmImei,
  conflict,
  missing,
  prepareBasket,
  printImei,
  unitForBasket,
} from "./workflow.js";

/** @typedef {Awaited<ReturnType<typeof import("../identity/sessions.js").identify>>} Actor */
/** @typedef {ReturnType<typeof import("../identity/store.js").identityStore>} Identity */
/** @typedef {import("express").Request} Request */
/** @typedef {import("express").Response} Response */
/** @typedef {import("mongodb").ClientSession} Session */
/** @typedef {import("./store.js").Basket} Basket */
/** @typedef {import("./store.js").BasketStatus} BasketStatus */
/** @typedef {{actor:import("../identity/store.js").User|null,module:string,action:string,correlationId:string}} AuditContext */

const states = /** @type {const} */ ([
  "preparing",
  "ready",
  "handed_over",
  "received",
  "cancelled",
]);
const printStates = /** @type {BasketStatus[]} */ ([
  "preparing",
  "ready",
  "handed_over",
  "received",
]);

/** @param {Response} response @param {unknown} output */
function reply(response, output) {
  response.json({ statusCode: 200, message: "موفق", result: output });
}
/** @param {Actor} actor @param {string} permission */
function hasAction(actor, permission) {
  if (!actor.grant.permissions.includes(permission))
    throw new ApiError(403, "FORBIDDEN", "دسترسی به این بخش مجاز نیست.");
}
/** @param {Actor} actor @param {Basket} basket */
function requireView(actor, basket) {
  if (
    (basket.status === "handed_over" || basket.status === "received") &&
    hasPermission(actor.grant, "assembly:approve", basket.scope)
  )
    return;
  requirePermission(actor.grant, "basket:view", basket.scope);
}
/** @param {Response} response @param {string} value */
async function barcode(response, value) {
  const png = await bwip.toBuffer({
    bcid: "code128",
    text: value,
    scale: 3,
    height: 12,
    includetext: false,
  });
  response
    .type("png")
    .set("Cache-Control", "private, no-store")
    .set("X-Content-Type-Options", "nosniff")
    .send(png);
}

/** @param {Identity} identity @param {(request:Request,response:Response)=>Promise<Actor>} authenticate @param {(response:Response,module:string,action:string)=>AuditContext} event @param {boolean} demo */
export function basketRouter(identity, authenticate, event, demo) {
  const store = basketStore(identity.database);
  const router = express.Router();
  const command = transactionCommands(
    identity,
    store.basketCommands,
    authenticate,
    event,
    "basket",
    conflict,
  );
  /** @param {unknown} id @param {Session} [session] */
  async function load(id, session) {
    const basket = await store.baskets.findOne(
      { _id: objectId(id) },
      { session },
    );
    if (!basket) throw missing();
    return basket;
  }

  router.get("/options", async (request, response) => {
    const actor = await authenticate(request, response);
    hasAction(actor, "basket:create");
    const search = request.query.q ? filterSearch(request.query.q) : undefined;
    const orders = await store.imei.orders
      .aggregate([
        {
          $match: {
            $and: [
              scopeQuery(actor.grant),
              search
                ? {
                    $or: [
                      { code: search },
                      { modelName: search },
                      { lineName: search },
                    ],
                  }
                : {},
            ],
          },
        },
        {
          $lookup: {
            from: store.imei.units.collectionName,
            let: { orderId: { $toString: "$_id" } },
            pipeline: [
              {
                $match: {
                  state: "allocated",
                  basketId: { $exists: false },
                  imeiError: { $exists: false },
                  hamtaStatus: { $exists: false },
                  $expr: { $eq: ["$orderId", "$$orderId"] },
                },
              },
              { $limit: 1 },
            ],
            as: "availableUnits",
          },
        },
        {
          $match: {
            $or: [
              { "availableUnits.0": { $exists: true } },
              {
                $expr: {
                  $lt: [{ $add: ["$allocated", "$replacementDue"] }, "$count"],
                },
              },
            ],
          },
        },
        { $sort: { _id: -1 } },
        { $limit: 50 },
        { $project: { code: 1, modelName: 1, lineName: 1, colorName: 1 } },
      ])
      .toArray();
    reply(
      response,
      orders.map((row) => ({
        id: String(row._id),
        code: row.code,
        modelName: row.modelName,
        lineName: row.lineName,
        colorName: row.colorName,
      })),
    );
  });
  router.get("/lines", async (request, response) => {
    const actor = await authenticate(request, response);
    if (!actor.grant.permissions.includes("assembly:approve"))
      hasAction(actor, "basket:view");
    reply(
      response,
      await lineOptions(
        { catalog: catalogStore(identity.database) },
        actor.grant,
      ),
    );
  });

  router.get("/", async (request, response) => {
    const actor = await authenticate(request, response);
    const incoming = request.query.mode === "incoming";
    hasAction(actor, incoming ? "assembly:approve" : "basket:view");
    const search = request.query.q ? filterSearch(request.query.q) : undefined;
    const status = states.find((value) => value === request.query.status);
    if (request.query.status && !status) throw badInput();
    const lineId = request.query.lineId
      ? objectId(request.query.lineId).toHexString()
      : undefined;
    /** @type {import('mongodb').Filter<Basket>} */
    const filter = {
      $and: [
        scopeQuery(actor.grant),
        lineId ? { lineId } : {},
        incoming ? { status: { $in: ["handed_over", "received"] } } : {},
        status ? { status } : {},
        search
          ? {
              $or: [
                { code: search },
                { unitCode: search },
                { modelName: search },
                { lineName: search },
              ],
            }
          : {},
      ],
    };
    const { skip, size } = pageInput(request.query);
    const [rows, count] = await Promise.all([
      store.baskets
        .find(filter)
        .sort({ _id: -1 })
        .skip(skip)
        .limit(size)
        .toArray(),
      store.baskets.countDocuments(filter),
    ]);
    reply(response, { data: rows.map(publicRow), count });
  });

  router.get("/:id", async (request, response) => {
    const actor = await authenticate(request, response);
    const basket = await load(request.params.id);
    requireView(actor, basket);
    const unit = await unitForBasket(store, basket);
    const can = (/** @type {string} */ name) =>
      hasPermission(actor.grant, name, basket.scope);
    const partRows = await store.parts
      .find({ basketId: String(basket._id) })
      .sort({ _id: 1 })
      .toArray();
    reply(response, {
      basket: publicRow(basket),
      coverage: Object.fromEntries(
        basket.needs.map((need) => {
          const rows = partRows.filter((part) => part.skuId === need.skuId);
          const allocated = rows
            .filter(
              (part) =>
                part.state === "allocated" || part.state === "installed",
            )
            .reduce((sum, part) => sum + minor(part.quantity.toString()), 0n);
          const printed = rows
            .filter((part) => part.state === "printed")
            .reduce((sum, part) => sum + minor(part.quantity.toString()), 0n);
          return [
            need.skuId,
            {
              allocated: amountText(allocated),
              remaining: amountText(minor(need.quantity) - allocated - printed),
            },
          ];
        }),
      ),
      unit: {
        id: String(unit._id),
        numbers: unit.numbers,
        labelVersion: unit.pairId,
        printed: Boolean(unit.printedAt),
        state: unit.state,
        imeiError: unit.imeiError,
        confirmed:
          unit.state === "allocated" &&
          !unit.imeiError &&
          basket.confirmedPairId === unit.pairId,
      },
      parts: partRows.map(publicPart),
      access: {
        create: can("basket:create"),
        scan: can("basket:scan"),
        edit: can("basket:edit"),
        approve: can("basket:approve"),
        transfer: can("basket:transfer"),
        receive:
          can("assembly:approve") && basket.handedBy !== String(actor.user._id),
        pdf: can("basket:pdf"),
        demo: demo && can("basket:scan"),
      },
    });
  });
  router.get("/:id/stock", async (request, response) => {
    const actor = await authenticate(request, response);
    const basket = await load(request.params.id);
    requirePermission(actor.grant, "basket:create", basket.scope);
    const skuId = objectId(request.query.skuId).toHexString();
    const search = request.query.q ? filterSearch(request.query.q) : undefined;
    const rows = await matchingStock(store, basket, {
      skuId,
      ...(search ? { cartonCode: search } : {}),
    }).toArray();
    reply(
      response,
      rows.map((row) =>
        publicCustody(
          /** @type {import("../inventory/store.js").Custody} */ (row),
        ),
      ),
    );
  });
  router.get("/:id/export", async (request, response) => {
    const actor = await authenticate(request, response);
    const basket = await load(request.params.id);
    requirePermission(actor.grant, "basket:view", basket.scope);
    requirePermission(actor.grant, "basket:pdf", basket.scope);
    await appendAudit(identity, event(response, "basket", "basket.export"), {
      result: "success",
      entityId: String(basket._id),
    });
    reply(response, { id: String(basket._id) });
  });
  router.get("/:id/labels/imei/:slot", async (request, response) => {
    const actor = await authenticate(request, response);
    const basket = await load(request.params.id);
    requirePermission(actor.grant, "basket:create", basket.scope);
    const unit = await unitForBasket(store, basket);
    const slot = request.params.slot;
    const number =
      slot === "1"
        ? unit.numbers[0]
        : slot === "2"
          ? unit.numbers[1]
          : undefined;
    if (
      !number ||
      (request.query.pair !== undefined &&
        unit.pairId !== request.query.pair) ||
      !unit.printedAt ||
      unit.state !== "allocated" ||
      unit.imeiError ||
      basket.status === "cancelled"
    )
      throw missing();
    await barcode(response, number);
  });
  router.get("/:id/labels/parts/:partId", async (request, response) => {
    const actor = await authenticate(request, response);
    const basket = await load(request.params.id);
    requirePermission(actor.grant, "basket:create", basket.scope);
    const part = await store.parts.findOne({
      _id: objectId(request.params.partId),
      basketId: String(basket._id),
      state: { $in: ["printed", "allocated"] },
    });
    if (!part) throw missing();
    await barcode(response, part.code);
  });

  router.post(
    "/",
    command(
      "basket.prepare",
      "basket:create",
      async (actor, request, session) => {
        const order = await store.imei.orders.findOne(
          { _id: objectId(fields(request.body).orderId) },
          { session },
        );
        if (!order) throw missing();
        requirePermission(actor.grant, "basket:create", order.scope);
        const output = await prepareBasket(
          store,
          order,
          String(actor.user._id),
          session,
        );
        return {
          id: output.id,
          output,
          scopes: [order.scope],
          audit: {
            orderId: output.orderId,
            unitId: output.unitId,
            bomVersionId: output.bomVersionId,
          },
        };
      },
    ),
  );

  /** @param {string} action @param {string} permission @param {BasketStatus[]} before @param {(basket:Basket,request:Request,actorId:string,session:Session)=>Promise<object>} perform */
  function change(action, permission, before, perform) {
    return command(action, permission, async (actor, request, session) => {
      const basket = await load(request.params.id, session);
      requirePermission(actor.grant, permission, basket.scope);
      assertVersion(basket, request.body, before);
      const output = await perform(
        basket,
        request,
        String(actor.user._id),
        session,
      );
      return {
        id: String(basket._id),
        output,
        scopes: [basket.scope],
        audit: {
          orderId: basket.orderId,
          unitId: basket.unitId,
          ...("part" in output ? { part: output.part } : {}),
        },
      };
    });
  }
  router.post(
    "/:id/imei/print",
    change(
      "basket.imei.print",
      "basket:create",
      printStates,
      (basket, _request, actor, session) =>
        printImei(store, basket, actor, session),
    ),
  );
  router.post(
    "/:id/imei/scan",
    change(
      "basket.imei.scan",
      "basket:scan",
      printStates,
      (basket, request, actor, session) =>
        confirmImei(store, basket, request.body, actor, session),
    ),
  );
  router.post(
    "/:id/parts",
    change(
      "basket.part.print",
      "basket:create",
      ["preparing"],
      (basket, request, _actor, session) =>
        createPartLabel(store, basket, request.body, session),
    ),
  );
  router.post(
    "/:id/parts/scan",
    change(
      "basket.part.scan",
      "basket:scan",
      ["preparing"],
      (basket, request, actor, session) =>
        scanPart(store, basket, request.body, actor, session),
    ),
  );
  router.post(
    "/:id/parts/:partId/remove",
    change(
      "basket.part.remove",
      "basket:edit",
      ["preparing"],
      (basket, request, actor, session) =>
        removePart(
          store,
          basket,
          request.params.partId,
          request.body,
          actor,
          session,
        ),
    ),
  );
  router.post(
    "/:id/ready",
    change(
      "basket.ready",
      "basket:approve",
      ["preparing"],
      (basket, _request, actor, session) =>
        advance(store, basket, "ready", actor, session),
    ),
  );
  router.post(
    "/:id/handover",
    change(
      "basket.handover",
      "basket:transfer",
      ["ready"],
      (basket, _request, actor, session) =>
        advance(store, basket, "handed_over", actor, session),
    ),
  );
  router.post(
    "/:id/receive",
    change(
      "basket.receive",
      "assembly:approve",
      ["handed_over"],
      (basket, _request, actor, session) =>
        advance(store, basket, "received", actor, session),
    ),
  );
  return router;
}
