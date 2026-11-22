import express from "express";
import bwip from "@bwip-js/node";
import { appendAudit } from "../identity/audit.js";
import {
  hasPermission,
  requirePermission,
  scopeKeys,
} from "../identity/permissions.js";
import { objectId, pageInput, text } from "../identity/validation.js";
import { createRecord, lookup, missing, updateRecord } from "./records.js";
import { catalogStore, publicEntry } from "./store.js";
import {
  idText,
  invalid,
  kindInput,
  kinds,
  scopedKinds,
} from "./validation.js";
import { publicVersion, publishVersion, versionType } from "./versions.js";

/** @typedef {Awaited<ReturnType<typeof import("../identity/sessions.js").identify>>} Actor */
/** @typedef {ReturnType<typeof import("../identity/store.js").identityStore>} IdentityStore */
/** @typedef {import("express").Request} Request */
/** @typedef {import("express").Response} Response */
/** @typedef {import("../identity/permissions.js").Scope} Scope */
/** @typedef {import("./store.js").Entry} Entry */
/** @typedef {import("./store.js").Revision} Revision */
/** @typedef {{ actor: import("../identity/store.js").User | null, module: string, action: string, correlationId: string }} AuditContext */

/** @param {Response} response @param {unknown} result @param {number} [status] */
const reply = (response, result, status = 200) =>
  response.status(status).json({ statusCode: status, message: "موفق", result });

/** @param {Actor} actor @param {string} action @param {Scope | null} scope */
function authorize(actor, action, scope = null) {
  if (scope === null && actor.grant.permissions.includes("master:" + action))
    return;
  requirePermission(actor.grant, "master:" + action, scope ?? {});
}

/** @param {Actor} actor */
function scopeFilter(actor) {
  if (actor.grant.organizationWide) return {};
  return {
    $or: actor.grant.scopes
      .map((scope) =>
        Object.fromEntries(
          scopeKeys
            .filter((key) => scope[key])
            .map((key) => ["scope." + key, scope[key]]),
        ),
      )
      .filter((rule) => Object.keys(rule).length),
  };
}

/**
 * @param {IdentityStore} identity
 * @param {(request: Request, response: Response) => Promise<Actor>} authenticate
 * @param {(response: Response,module: string,action: string) => AuditContext} event
 */
export function catalogRouter(identity, authenticate, event) {
  const store = catalogStore(identity.database);
  const router = express.Router();

  router.get("/kinds", async (request, response) => {
    const actor = await authenticate(request, response);
    authorize(actor, "view");
    reply(response, kinds);
  });

  router.get("/scope-options", async (request, response) => {
    const actor = await authenticate(request, response);
    requirePermission(actor.grant, "users:users");
    const data = await store.records
      .find({
        kind: { $in: ["branches", "warehouses", "lines", "stations"] },
        active: true,
      })
      .sort({ kind: 1, code: 1 })
      .toArray();
    reply(response, data.map(publicEntry));
  });

  router.get("/versions", async (request, response) => {
    const actor = await authenticate(request, response);
    authorize(actor, "view");
    const type = versionType(request.query.type);
    const modelId = idText(request.query.modelId);
    /** @type {import("mongodb").Filter<Revision>} */
    const filter = { type, modelId };
    if (type === "routing") {
      Object.assign(filter, scopeFilter(actor));
      if (request.query.lineId) filter.lineId = idText(request.query.lineId);
    }
    const { skip, size } = pageInput(request.query);
    const [data, count] = await Promise.all([
      store.versions
        .find(filter)
        .sort({ revision: -1, _id: -1 })
        .skip(skip)
        .limit(size)
        .toArray(),
      store.versions.countDocuments(filter),
    ]);
    reply(response, { data: data.map(publicVersion), count });
  });

  router.get("/versions/:id", async (request, response) => {
    const actor = await authenticate(request, response);
    const version = await store.versions.findOne({
      _id: objectId(request.params.id),
    });
    if (
      !version ||
      (version.type === "routing" &&
        !hasPermission(actor.grant, "master:view", version.scope))
    )
      throw missing();
    authorize(actor, "view");
    reply(response, publicVersion(version));
  });

  router.post("/versions", async (request, response) => {
    event(response, "master", "version.publish");
    const actor = await authenticate(request, response);
    authorize(actor, "edit");
    const context = event(response, "master", "version.publish");
    const result = await identity.database.transaction(async (session) => {
      const version = publicVersion(
        await publishVersion(
          store,
          request.body,
          String(actor.user._id),
          session,
          (scope) => authorize(actor, "edit", scope),
        ),
      );
      await appendAudit(
        identity,
        context,
        { result: "success", entityId: version.id, after: version },
        session,
      );
      return version;
    });
    reply(response, result, 201);
  });

  /** @param {Entry} entry @param {Actor} actor @param {string} action */
  function authorizeEntry(entry, actor, action) {
    authorize(actor, action, scopedKinds.has(entry.kind) ? entry.scope : null);
  }

  router.get(["/:kind", "/:kind/export"], async (request, response) => {
    const actor = await authenticate(request, response);
    const exporting = request.path.endsWith("/export");
    const kind = kindInput(request.params.kind);
    authorize(actor, "view");
    if (exporting) authorize(actor, "pdf");
    const filter = /** @type {import("mongodb").Filter<Entry>} */ ({ kind });
    if (scopedKinds.has(kind)) Object.assign(filter, scopeFilter(actor));
    if (request.query.active === "true") filter.active = true;
    if (request.query.parentId)
      filter.parentId = idText(request.query.parentId);
    if (request.query.partTypeId !== undefined) {
      if (kind !== "skus") throw invalid("فیلتر نوع قطعه فقط برای قطعات است.");
      Object.assign(filter, {
        "data.partTypeId": idText(request.query.partTypeId),
      });
    }
    if (request.query.modelId !== undefined) {
      if (kind !== "stations")
        throw invalid("فیلتر مدل فقط برای ایستگاه‌ها است.");
      const modelId = idText(request.query.modelId);
      const routes =
        /** @type {{ steps: NonNullable<Revision["steps"]> }[]} */ (
          await store.versions
            .aggregate([
              { $match: { type: "routing", modelId } },
              { $sort: { lineId: 1, revision: -1 } },
              { $group: { _id: "$lineId", steps: { $first: "$steps" } } },
            ])
            .toArray()
        );
      filter._id = {
        $in: routes.flatMap(({ steps }) =>
          steps.map((step) => objectId(step.stationId)),
        ),
      };
    }
    if (request.query.q) {
      const query = new RegExp(
        text(request.query.q, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i",
      );
      const search = { $or: [{ code: query }, { name: query }] };
      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, search];
        delete filter.$or;
      } else filter.$or = search.$or;
    }
    const { skip, size } = pageInput(request.query);
    const [data, count] = await Promise.all([
      store.records
        .find(filter)
        .sort({ code: 1, _id: 1 })
        .skip(skip)
        .limit(size)
        .toArray(),
      store.records.countDocuments(filter),
    ]);
    if (exporting)
      await appendAudit(identity, event(response, "master", "catalog.export"), {
        result: "success",
      });
    reply(response, { data: data.map(publicEntry), count });
  });

  router.get("/:kind/:id/barcode", async (request, response) => {
    const actor = await authenticate(request, response);
    const record = await lookup(
      store,
      kindInput(request.params.kind),
      idText(request.params.id),
    );
    if (!record) throw missing();
    authorizeEntry(record, actor, "view");
    authorizeEntry(record, actor, "pdf");
    const barcode = record.parentId
      ? `${record.kind.toUpperCase()}:${record.parentId}:${record.code}`
      : record.code;
    const png = await bwip.toBuffer({
      bcid: "code128",
      text: barcode,
      scale: 2,
      height: 12,
      padding: 6,
    });
    response.type("png").send(png);
  });

  router.get("/:kind/:id", async (request, response) => {
    const actor = await authenticate(request, response);
    const record = await lookup(
      store,
      kindInput(request.params.kind),
      idText(request.params.id),
    );
    if (!record) throw missing();
    authorizeEntry(record, actor, "view");
    reply(response, publicEntry(record));
  });

  router.post("/:kind", async (request, response) => {
    event(response, "master", "catalog.create");
    const actor = await authenticate(request, response);
    authorize(actor, "create");
    const kind = kindInput(request.params.kind);
    const context = event(response, "master", "catalog.create");
    const result = await identity.database.transaction(async (session) => {
      const after = publicEntry(
        await createRecord(store, kind, request.body, session, (scope) =>
          authorize(actor, "create", scope),
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
    reply(response, result, 201);
  });

  router.patch("/:kind/:id", async (request, response) => {
    event(response, "master", "catalog.update");
    const actor = await authenticate(request, response);
    const kind = kindInput(request.params.kind);
    authorize(actor, kind === "stations" ? "settings" : "edit");
    const id = idText(request.params.id);
    const context = event(response, "master", "catalog.update");
    const result = await identity.database.transaction(async (session) => {
      const current = await lookup(store, kind, id, session);
      if (!current) throw missing();
      authorize(
        actor,
        kind === "stations" ? "settings" : "edit",
        current.scope,
      );
      const after = publicEntry(
        await updateRecord(store, current, request.body, session),
      );
      await appendAudit(
        identity,
        context,
        {
          result: "success",
          entityId: id,
          before: publicEntry(current),
          after,
        },
        session,
      );
      return after;
    });
    reply(response, result);
  });

  return router;
}
