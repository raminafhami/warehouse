import { Buffer } from "node:buffer";
import bwip from "@bwip-js/node";
import express from "express";
import { ObjectId } from "mongodb";
import { catalogStore } from "../catalog/store.js";
import { appendAudit } from "../identity/audit.js";
import {
  hasPermission,
  requirePermission,
  scopeKeys,
} from "../identity/permissions.js";
import { objectId, pageInput, text } from "../identity/validation.js";
import { maxWaybillBytes, parseWaybill, saveWaybill } from "./files.js";
import {
  absent,
  assertOpen,
  createShipment,
  removeCarton,
  scanCarton,
  scanPallet,
  touchShipment,
  violation,
} from "./operations.js";
import { receiveShipment, resolveDiscrepancy } from "./receipt.js";
import {
  publicCarton,
  publicPallet,
  publicReceipt,
  publicShipment,
  shipmentStore,
} from "./store.js";

/** @typedef {Awaited<ReturnType<typeof import("../identity/sessions.js").identify>>} Actor */
/** @typedef {ReturnType<typeof import("../identity/store.js").identityStore>} IdentityStore */
/** @typedef {import("./store.js").Shipment} Shipment */
/** @typedef {import("express").Request} Request */
/** @typedef {import("express").Response} Response */
/** @typedef {{ actor: import("../identity/store.js").User | null, module: string, action: string, correlationId: string }} AuditContext */
/** @typedef {(shipment: Shipment, request: Request, session: import("mongodb").ClientSession, actor: Actor) => Promise<{output: object, audit?: object, replayed?: boolean}>} Action */

/** @param {Response} response @param {unknown} result @param {number} [status] */
const reply = (response, result, status = 200) =>
  response.status(status).json({ statusCode: status, message: "موفق", result });

/**
 * @param {IdentityStore} identity
 * @param {(request: Request,response: Response) => Promise<Actor>} authenticate
 * @param {(response: Response,module: string,action: string) => AuditContext} event
 */
export function shipmentsRouter(identity, authenticate, event) {
  const store = shipmentStore(identity.database);
  const catalog = catalogStore(identity.database);
  const router = express.Router();

  /** @param {Actor} actor @param {string} permission */
  function requireModule(actor, permission) {
    if (!actor.grant.permissions.includes("shipments:" + permission))
      requirePermission(actor.grant, "shipments:" + permission);
  }

  /**
   * @param {ObjectId} id @param {Actor} actor @param {string} permission
   * @param {import("mongodb").ClientSession} [session]
   */
  async function load(id, actor, permission, session) {
    requireModule(actor, permission);
    const shipment = await store.shipments.findOne({ _id: id }, { session });
    if (!shipment) throw absent();
    requirePermission(actor.grant, "shipments:" + permission, shipment.scope);
    return shipment;
  }

  router.get("/options", async (request, response) => {
    const actor = await authenticate(request, response);
    requireModule(actor, "create");
    const warehouses = (
      await catalog.records
        .find({ kind: "warehouses", active: true })
        .sort({ code: 1 })
        .toArray()
    ).filter((warehouse) =>
      hasPermission(actor.grant, "shipments:create", warehouse.scope),
    );
    const suppliers = warehouses.length
      ? await catalog.records
          .find({ kind: "suppliers", active: true })
          .sort({ code: 1 })
          .toArray()
      : [];
    const simple = (
      /** @type {import("../catalog/store.js").Entry} */ entry,
    ) => ({
      id: String(entry._id),
      code: entry.code,
      name: entry.name,
    });
    reply(response, {
      warehouses: warehouses.map(simple),
      suppliers: suppliers.map(simple),
    });
  });

  router.get(["/", "/export"], async (request, response) => {
    const exporting = request.path === "/export";
    const action = exporting ? "shipment.export" : "shipment.list";
    event(response, "shipments", action);
    const actor = await authenticate(request, response);
    requireModule(actor, "view");
    if (exporting) requireModule(actor, "pdf");
    /** @type {import("mongodb").Filter<Shipment>[]} */
    const filters = [];
    if (!actor.grant.organizationWide) {
      const allowed = actor.grant.scopes
        .map((scope) =>
          Object.fromEntries(
            scopeKeys
              .filter((key) => scope[key])
              .map((key) => ["scope." + key, scope[key]]),
          ),
        )
        .filter((rule) => Object.keys(rule).length);
      if (!allowed.length) {
        reply(response, { data: [], count: 0 });
        return;
      }
      filters.push({ $or: allowed });
    }
    if (request.query.status) {
      const status = request.query.status;
      if (
        status !== "receiving" &&
        status !== "discrepancy" &&
        status !== "approved"
      )
        throw violation("وضعیت فیلتر معتبر نیست.");
      filters.push({ status });
    }
    if (request.query.q) {
      const search = new RegExp(
        text(request.query.q, 80).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i",
      );
      filters.push({
        $or: [
          { code: search },
          { supplierName: search },
          { waybillNumber: search },
        ],
      });
    }
    const { skip, size } = pageInput(request.query);
    const filter = filters.length ? { $and: filters } : {};
    const [data, count] = await Promise.all([
      store.shipments
        .find(filter)
        .sort({ createdAt: -1, sequence: -1 })
        .skip(skip)
        .limit(size)
        .toArray(),
      store.shipments.countDocuments(filter),
    ]);
    if (exporting)
      await appendAudit(identity, event(response, "shipments", action), {
        result: "success",
      });
    reply(response, { data: data.map(publicShipment), count });
  });

  router.post("/", async (request, response) => {
    event(response, "shipments", "shipment.create");
    const actor = await authenticate(request, response);
    requireModule(actor, "create");
    const context = event(response, "shipments", "shipment.create");
    const shipment = await identity.database.transaction(async (session) => {
      const after = publicShipment(
        await createShipment(
          store,
          catalog,
          request.body,
          String(actor.user._id),
          session,
          (scope) => requirePermission(actor.grant, "shipments:create", scope),
        ),
      );
      await appendAudit(
        identity,
        context,
        { result: "success", entityId: after.id, after },
        session,
      );
      return after;
    });
    reply(response, shipment, 201);
  });

  router.get("/:id", async (request, response) => {
    const actor = await authenticate(request, response);
    const shipment = await load(objectId(request.params.id), actor, "view");
    const shipmentId = String(shipment._id);
    const [pallets, cartons, receipts, skus] = await Promise.all([
      store.pallets.find({ shipmentId }).sort({ at: 1 }).toArray(),
      store.cartons
        .find({ shipmentId, state: { $ne: "removed" } })
        .sort({ at: 1 })
        .toArray(),
      store.receipts.find({ shipmentId }).sort({ at: -1 }).toArray(),
      hasPermission(actor.grant, "shipments:scan", shipment.scope) &&
      shipment.status !== "approved"
        ? catalog.records
            .find({
              kind: "skus",
              active: true,
              "data.supplierId": shipment.supplierId,
            })
            .sort({ code: 1 })
            .toArray()
        : [],
    ]);
    reply(response, {
      shipment: publicShipment(shipment),
      pallets: pallets.map(publicPallet),
      cartons: cartons.map(publicCarton),
      receipts: receipts.map(publicReceipt),
      skus: skus.map((sku) => ({
        id: String(sku._id),
        code: sku.code,
        name: sku.name,
      })),
    });
  });

  /** @param {string} action @param {string} permission @param {Action} perform @param {number} [status] @returns {import("express").RequestHandler} */
  function mutate(action, permission, perform, status = 200) {
    return async (request, response) => {
      event(response, "shipments", action);
      const actor = /** @type {Actor} */ (
        response.locals.actor ?? (await authenticate(request, response))
      );
      const context = event(response, "shipments", action);
      const id = objectId(request.params.id);
      const result = await identity.database.transaction(async (session) => {
        const shipment = await load(id, actor, permission, session);
        const { output, audit, replayed } = await perform(
          shipment,
          request,
          session,
          actor,
        );
        if (!replayed) {
          await appendAudit(
            identity,
            context,
            { result: "success", entityId: String(id), after: audit ?? output },
            session,
          );
        }
        return { output, replayed };
      });
      reply(response, result.output, result.replayed ? 200 : status);
    };
  }

  router.post(
    "/:id/pallets",
    mutate(
      "pallet.scan",
      "scan",
      async (shipment, request, session) => ({
        output: publicPallet(
          await scanPallet(store, shipment, request.body, session),
        ),
      }),
      201,
    ),
  );

  router.post(
    "/:id/cartons",
    mutate(
      "carton.scan",
      "scan",
      async (shipment, request, session) => ({
        output: publicCarton(
          await scanCarton(store, catalog, shipment, request.body, session),
        ),
      }),
      201,
    ),
  );

  router.delete(
    "/:id/cartons/:cartonId",
    mutate("carton.remove", "edit", async (shipment, request, session) => {
      const carton = await removeCarton(
        store,
        shipment,
        objectId(request.params.cartonId),
        session,
      );
      return {
        output: { id: String(carton._id), state: "removed" },
        audit: { ...publicCarton(carton), state: "removed" },
      };
    }),
  );

  router.post(
    "/:id/receipts",
    mutate(
      "shipment.receive",
      "approve",
      async (shipment, request, session, actor) => {
        const result = await receiveShipment(
          store,
          shipment,
          request.body,
          request.get("Idempotency-Key"),
          String(actor.user._id),
          session,
        );
        return { output: result.receipt, replayed: result.replayed };
      },
      201,
    ),
  );

  router.post(
    "/:id/discrepancy/resolution",
    mutate(
      "shipment.resolve",
      "approve",
      async (shipment, request, session, actor) => ({
        output: publicShipment(
          await resolveDiscrepancy(
            store,
            shipment,
            request.body,
            String(actor.user._id),
            session,
          ),
        ),
      }),
    ),
  );

  router.put(
    "/:id/waybill",
    async (request, response, next) => {
      event(response, "shipments", "waybill.upload");
      const actor = await authenticate(request, response);
      const shipment = await load(objectId(request.params.id), actor, "create");
      assertOpen(shipment);
      next();
    },
    express.raw({ type: () => true, limit: maxWaybillBytes, inflate: false }),
    mutate("waybill.upload", "create", async (shipment, request, session) => {
      assertOpen(shipment);
      const file = parseWaybill(
        request.body,
        request.get("Content-Type"),
        request.get("X-Filename"),
      );
      const metadata = await saveWaybill(
        store,
        String(shipment._id),
        file,
        session,
      );
      await touchShipment(store, shipment, session, {
        $set: { waybill: metadata },
      });
      return { output: metadata };
    }),
  );

  router.get("/:id/labels/:code", async (request, response) => {
    const actor = await authenticate(request, response);
    const shipment = await load(objectId(request.params.id), actor, "view");
    requirePermission(actor.grant, "shipments:pdf", shipment.scope);
    const code = text(request.params.code, 35);
    const shipmentId = String(shipment._id);
    const record = code.startsWith("PLT-")
      ? await store.pallets.findOne({ shipmentId, code })
      : await store.cartons.findOne({
          shipmentId,
          code,
          state: { $ne: "removed" },
        });
    if (!record) throw absent();
    const png = await bwip.toBuffer({
      bcid: "code128",
      text: record.code,
      scale: 2,
      height: 12,
      padding: 6,
    });
    response.type("png").set("X-Content-Type-Options", "nosniff").send(png);
  });

  router.get("/:id/waybill", async (request, response) => {
    const actor = await authenticate(request, response);
    const shipment = await load(objectId(request.params.id), actor, "view");
    if (!shipment.waybill) throw absent();
    const file = await store.files.findOne({
      _id: new ObjectId(shipment.waybill.fileId),
      shipmentId: String(shipment._id),
    });
    if (!file) throw absent();
    response
      .attachment(file.name)
      .type(file.type)
      .set("X-Content-Type-Options", "nosniff")
      .send(Buffer.from(file.content.value()));
  });

  return router;
}
