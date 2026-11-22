import { Buffer } from "node:buffer";
import express from "express";
import { Binary, ObjectId } from "mongodb";
import { catalogStore } from "../catalog/store.js";
import { maxDocumentBytes, parseDocument } from "../document-upload.js";
import { ApiError } from "../http-error.js";
import { transactionCommands } from "../identity/commands.js";
import { appendAudit } from "../identity/audit.js";
import { hasPermission, requirePermission } from "../identity/permissions.js";
import {
  badInput,
  fields,
  objectId,
  pageInput,
  text,
  versionInput,
} from "../identity/validation.js";
import { filterSearch, scopeQuery } from "../inventory/queries.js";
import {
  hamtaAction,
  recordHamta,
  recordImeiError,
  simulateHamta,
} from "./hamta.js";
import { importPairs, latinDigits } from "./imports.js";
import {
  allocateUnit,
  conflict,
  createOrder,
  history,
  missing,
  retirePair,
} from "./orders.js";
import { imeiStore, publicRow } from "./store.js";

/** @typedef {Awaited<ReturnType<typeof import("../identity/sessions.js").identify>>} Actor */
/** @typedef {ReturnType<typeof import("../identity/store.js").identityStore>} Identity */
/** @typedef {import("express").Request} Request */
/** @typedef {import("express").Response} Response */
/** @typedef {import("mongodb").ClientSession} Session */
/** @typedef {{actor:import("../identity/store.js").User|null,module:string,action:string,correlationId:string}} AuditContext */

const forbidden = () =>
  new ApiError(403, "FORBIDDEN", "دسترسی به این عملیات مجاز نیست.");
/** @param {Actor} actor @param {string} permission */
function hasAction(actor, permission) {
  if (!actor.grant.permissions.includes(permission)) throw forbidden();
}
/** @param {Response} response @param {unknown} result @param {number} [status] */
const reply = (response, result, status = 200) =>
  response.status(status).json({ statusCode: status, message: "موفق", result });

/** @template {{_id:import("mongodb").ObjectId}} T @param {import("mongodb").Collection<T>} collection @param {unknown} id @param {Session} [session] */
async function load(collection, id, session) {
  const row = await collection.findOne(
    /** @type {import("mongodb").Filter<T>} */ ({ _id: objectId(id) }),
    { session },
  );
  if (!row) throw missing();
  return row;
}

/** @template {{_id:import("mongodb").ObjectId}} T @param {import("mongodb").Collection<T>} collection @param {import("mongodb").Filter<T>} filter @param {Request["query"]} query */
async function list(collection, filter, query) {
  const { skip, size } = pageInput(query);
  const [rows, count] = await Promise.all([
    collection.find(filter).sort({ _id: -1 }).skip(skip).limit(size).toArray(),
    collection.countDocuments(filter),
  ]);
  return { data: rows.map(publicRow), count };
}

/** @param {Identity} identity @param {(request:Request,response:Response)=>Promise<Actor>} authenticate @param {(response:Response,module:string,action:string)=>AuditContext} event @param {boolean} demo */
export function imeiRouter(identity, authenticate, event, demo) {
  const store = imeiStore(identity.database);
  const catalog = catalogStore(identity.database);
  const router = express.Router();

  const command = transactionCommands(
    identity,
    store.commands,
    authenticate,
    event,
    "imei",
    conflict,
  );

  router.get("/options", async (request, response) => {
    const actor = await authenticate(request, response);
    hasAction(actor, "imei:view");
    const [models, lines, colors] = await Promise.all([
      catalog.records
        .find({ kind: "models", active: true })
        .sort({ code: 1 })
        .toArray(),
      catalog.records
        .find({ kind: "lines", active: true, ...scopeQuery(actor.grant) })
        .sort({ code: 1 })
        .toArray(),
      catalog.records
        .find({ kind: "colors", active: true })
        .sort({ code: 1 })
        .toArray(),
    ]);
    const option = (
      /** @type {import("../catalog/store.js").Entry} */ row,
    ) => ({ id: String(row._id), name: row.name, code: row.code });
    reply(response, {
      models: models.map((row) => ({
        ...option(row),
        imeiSlots: row.data.imeiSlots,
        colorIds: row.data.colorIds,
      })),
      lines: lines
        .filter((line) => hasPermission(actor.grant, "imei:create", line.scope))
        .map(option),
      colors: colors.map(option),
      canImport: hasPermission(actor.grant, "imei:create", {}),
      canViewImports: hasPermission(actor.grant, "imei:view", {}),
      demo: demo && actor.grant.permissions.includes("imei:approve"),
    });
  });

  router.get(
    [
      "/pool",
      "/orders",
      "/hamta",
      "/pool/export",
      "/orders/export",
      "/hamta/export",
    ],
    async (request, response) => {
      const actor = await authenticate(request, response);
      hasAction(actor, "imei:view");
      const exporting = request.path.endsWith("/export");
      if (exporting) hasAction(actor, "imei:pdf");
      const kind = request.path.split("/")[1];
      const scope = scopeQuery(actor.grant);
      const { q } = request.query;
      const status = request.query.status || undefined;
      const searchText = q ? latinDigits(text(q, 100)) : "";
      const search = searchText
        ? filterSearch(
            /^[\d\s-]+$/.test(searchText) && /\d/.test(searchText)
              ? searchText.replace(/[\s-]/g, "")
              : searchText,
          )
        : undefined;
      let result;
      if (kind === "orders") {
        result = await list(
          store.orders,
          {
            $and: [
              scope,
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
          request.query,
        );
      } else if (kind === "hamta") {
        const states = /** @type {const} */ ([
          "pending",
          "submitted",
          "activated",
          "error",
        ]);
        const selected = states.find((value) => value === status);
        if (status && !selected) throw badInput();
        const units = await list(
          store.units,
          {
            $and: [
              scope,
              { hamtaStatus: selected ?? { $in: states } },
              search
                ? {
                    $or: [
                      { numbers: search },
                      { code: search },
                      { trackingCode: search },
                      { modelName: search },
                    ],
                  }
                : {},
            ],
          },
          request.query,
        );
        result = {
          ...units,
          data: units.data.map((unit) => ({
            ...unit,
            canApprove: hasPermission(actor.grant, "imei:approve", unit.scope),
          })),
        };
      } else {
        const pairStates = /** @type {const} */ (["free", "allocated", "void"]);
        const hamtaStates = /** @type {const} */ ([
          "pending",
          "submitted",
          "activated",
          "error",
        ]);
        const selected = pairStates.find((value) => value === status);
        const hamta = hamtaStates.find((value) => value === status);
        if (status && !selected && !hamta) throw badInput();
        const state = selected
          ? { status: selected }
          : hamta === "error"
            ? { $or: [{ hamtaStatus: hamta }, { hasError: true }] }
            : hamta
              ? { hamtaStatus: hamta }
              : {};
        result = await list(
          store.pairs,
          {
            $and: [
              scope,
              state,
              search
                ? { $or: [{ numbers: search }, { modelName: search }] }
                : {},
            ],
          },
          request.query,
        );
      }
      if (exporting)
        await appendAudit(identity, event(response, "imei", kind + ".export"), {
          result: "success",
        });
      reply(response, result);
    },
  );

  router.get("/imports", async (request, response) => {
    const actor = await authenticate(request, response);
    requirePermission(actor.grant, "imei:view", {});
    reply(response, await list(store.imports, {}, request.query));
  });
  router.get("/orders/:id", async (request, response) => {
    const actor = await authenticate(request, response);
    const order = await load(store.orders, request.params.id);
    requirePermission(actor.grant, "imei:view", order.scope);
    const orderId = String(order._id);
    const units = await list(store.units, { orderId }, request.query);
    const permitted = (/** @type {string} */ action) =>
      hasPermission(actor.grant, action, order.scope);
    reply(response, {
      order: publicRow(order),
      ...units,
      access: {
        allocate: permitted("imei:edit"),
        release: permitted("imei:edit"),
        void: permitted("imei:reject") && permitted("finalQc:edit"),
        error: permitted("imei:reject"),
      },
    });
  });
  router.get("/units/:id/history", async (request, response) => {
    const actor = await authenticate(request, response);
    const unit = await load(store.units, request.params.id);
    requirePermission(actor.grant, "imei:view", unit.scope);
    reply(
      response,
      await list(store.history, { entityId: String(unit._id) }, request.query),
    );
  });

  router.post(
    "/imports",
    command("pool.import", "imei:create", async (actor, request, session) => {
      requirePermission(actor.grant, "imei:create", {});
      const result = await importPairs(
        store,
        request.body,
        String(actor.user._id),
        session,
      );
      return {
        id: result.id,
        output: result,
        scopes: [{}],
        audit: {
          accepted: result.accepted,
          rejected: result.errors.length,
          source: result.source,
          modelId: result.modelId,
        },
      };
    }),
  );
  router.post(
    "/orders",
    command("order.create", "imei:create", async (actor, request, session) => {
      const result = await createOrder(
        store,
        request.body,
        (scope) => requirePermission(actor.grant, "imei:create", scope),
        session,
      );
      return {
        id: result.id,
        output: result,
        scopes: [result.scope],
        audit: {
          code: result.code,
          count: result.count,
          modelId: result.modelId,
        },
      };
    }),
  );
  router.post(
    "/orders/:id/units",
    command("unit.allocate", "imei:edit", async (actor, request, session) => {
      const order = await load(store.orders, request.params.id, session);
      requirePermission(actor.grant, "imei:edit", order.scope);
      const output = await allocateUnit(
        store,
        order,
        String(actor.user._id),
        session,
      );
      return {
        id: output.id,
        output,
        scopes: [order.scope],
        audit: { orderId: output.orderId, pairId: output.pairId },
      };
    }),
  );
  router.post(
    "/units/:id/replace",
    command("unit.replace", "imei:edit", async (actor, request, session) => {
      const unit = await load(store.units, request.params.id, session);
      requirePermission(actor.grant, "imei:edit", unit.scope);
      if (unit.version !== versionInput(fields(request.body).version))
        throw conflict("نسخهٔ گوشی تغییر کرده است.");
      const order = await load(store.orders, unit.orderId, session);
      const output = await allocateUnit(
        store,
        order,
        String(actor.user._id),
        session,
        unit,
      );
      return {
        id: output.id,
        output,
        scopes: [unit.scope],
        audit: { orderId: output.orderId, pairId: output.pairId },
      };
    }),
  );
  for (const operation of /** @type {const} */ (["released", "void"])) {
    const voiding = operation === "void";
    const permission = voiding ? "imei:reject" : "imei:edit";
    router.post(
      "/units/:id/" + (voiding ? "void" : "release"),
      command(
        "unit." + operation,
        permission,
        async (actor, request, session) => {
          const unit = await load(store.units, request.params.id, session);
          requirePermission(actor.grant, permission, unit.scope);
          if (voiding)
            requirePermission(actor.grant, "finalQc:edit", unit.scope);
          const output = await retirePair(
            store,
            unit,
            request.body,
            operation,
            String(actor.user._id),
            session,
          );
          return {
            id: output.id,
            output,
            scopes: [unit.scope],
            audit: { orderId: output.orderId, pairId: output.pairId },
          };
        },
        voiding ? "finalQc:edit" : undefined,
      ),
    );
  }
  router.post(
    "/units/:id/error",
    command("unit.error", "imei:reject", async (actor, request, session) => {
      const unit = await load(store.units, request.params.id, session);
      requirePermission(actor.grant, "imei:reject", unit.scope);
      const output = await recordImeiError(
        store,
        unit,
        request.body,
        String(actor.user._id),
        session,
      );
      return {
        id: output.id,
        output,
        scopes: [unit.scope],
        audit: { orderId: output.orderId, pairId: output.pairId },
      };
    }),
  );

  router.post(
    "/hamta/results",
    command("hamta.result", "imei:approve", async (actor, request, session) => {
      const body = fields(request.body);
      const action = hamtaAction(body.action);
      if (
        !Array.isArray(body.entries) ||
        !body.entries.length ||
        body.entries.length > 50
      )
        throw badInput();
      const ids = new Set();
      const scopes = [];
      const data = [];
      for (const item of body.entries) {
        const entry = fields(item);
        const unit = await load(store.units, entry.id, session);
        const unitId = String(unit._id);
        if (ids.has(unitId)) throw badInput();
        ids.add(unitId);
        requirePermission(actor.grant, "imei:approve", unit.scope);
        scopes.push(unit.scope);
        data.push(
          await recordHamta(
            store,
            unit,
            entry,
            action,
            String(actor.user._id),
            session,
          ),
        );
      }
      return {
        id: data[0].id,
        output: { data },
        scopes,
        audit: {
          action,
          units: data.map((row) => ({ id: row.id, status: row.hamtaStatus })),
        },
      };
    }),
  );
  router.post(
    "/units/:id/official-corrections",
    command(
      "hamta.official-correction",
      "imei:approve",
      async (actor, request, session) => {
        const unit = await load(store.units, request.params.id, session);
        requirePermission(actor.grant, "imei:approve", unit.scope);
        if (unit.hamtaStatus !== "activated")
          throw conflict("گوشی باید در همتا فعال شده باشد.");
        const body = fields(request.body);
        const detail = {
          reference: text(body.reference, 240),
          reason: text(body.reason, 500),
        };
        await history(
          store,
          String(unit._id),
          "hamta.official-correction",
          String(actor.user._id),
          unit.scope,
          detail,
          session,
        );
        return {
          id: String(unit._id),
          output: detail,
          scopes: [unit.scope],
          audit: detail,
        };
      },
    ),
  );
  router.post(
    "/units/:id/hamta-evidence",
    async (request, response, next) => {
      const actor = await authenticate(request, response);
      const unit = await load(store.units, request.params.id);
      requirePermission(actor.grant, "imei:approve", unit.scope);
      next();
    },
    express.raw({ type: () => true, limit: maxDocumentBytes, inflate: false }),
    command(
      "hamta.evidence",
      "imei:approve",
      async (actor, request, session) => {
        const unit = await load(store.units, request.params.id, session);
        requirePermission(actor.grant, "imei:approve", unit.scope);
        if (unit.hamtaStatus !== "activated" || unit.evidenceFile)
          throw conflict("برای این گوشی امکان ثبت فایل شاهد وجود ندارد.");
        const file = parseDocument(
          request.body,
          request.get("Content-Type"),
          request.get("X-Filename"),
          {
            required: "فایل شاهد همتا را انتخاب کنید.",
            large: "حجم فایل شاهد باید حداکثر ۱٫۵ مگابایت باشد.",
            typeCode: "INVALID_EVIDENCE_TYPE",
            filename: "نام فایل شاهد همتا معتبر نیست.",
          },
        );
        const id = new ObjectId();
        const unitId = String(unit._id);
        const info = { id: String(id), name: file.name };
        await store.evidence.insertOne(
          {
            _id: id,
            unitId,
            name: file.name,
            type: file.contentType,
            content: new Binary(file.bytes),
            at: new Date(),
          },
          { session },
        );
        const changed = await store.units.updateOne(
          { _id: unit._id, version: unit.version },
          { $set: { evidenceFile: info }, $inc: { version: 1 } },
          { session },
        );
        if (!changed.modifiedCount) throw conflict("نسخهٔ گوشی تغییر کرده است.");
        await history(
          store,
          unitId,
          "hamta.evidence",
          String(actor.user._id),
          unit.scope,
          info,
          session,
        );
        return { id: unitId, output: info, scopes: [unit.scope], audit: info };
      },
    ),
  );
  router.get("/units/:id/hamta-evidence", async (request, response) => {
    const actor = await authenticate(request, response);
    const unit = await load(store.units, request.params.id);
    requirePermission(actor.grant, "imei:view", unit.scope);
    if (!unit.evidenceFile) throw missing();
    const file = await store.evidence.findOne({
      _id: new ObjectId(unit.evidenceFile.id),
      unitId: String(unit._id),
    });
    if (!file) throw missing();
    response
      .attachment(file.name)
      .type(file.type)
      .set("X-Content-Type-Options", "nosniff")
      .set("Cache-Control", "private, no-store")
      .send(Buffer.from(file.content.buffer));
  });
  if (demo)
    router.post("/hamta/simulate", async (request, response) => {
      const actor = await authenticate(request, response);
      hasAction(actor, "imei:approve");
      reply(response, simulateHamta(fields(request.body).outcome));
    });
  return router;
}
