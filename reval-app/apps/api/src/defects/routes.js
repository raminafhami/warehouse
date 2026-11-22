import express from "express";
import bwip from "@bwip-js/node";
import { assemblyStore } from "../assembly/store.js";
import { conflict, loadVisit, missing } from "../assembly/workflow.js";
import { publicPart } from "../basket/parts.js";
import { ApiError } from "../http-error.js";
import { transactionCommands } from "../identity/commands.js";
import { hasPermission, requirePermission } from "../identity/permissions.js";
import { fields, objectId, pageInput } from "../identity/validation.js";
import { publicRow } from "../imei/store.js";
import { scopeQuery } from "../inventory/queries.js";
import {
  caseActions,
  caseDetail,
  loadCase,
  openCase,
  updateCase,
} from "./cases.js";
import {
  advanceReturn,
  createReturn,
  loadReturn,
  receive,
  returnScope,
} from "./returns.js";

/** @typedef {import("../identity/commands.js").Identity} Identity */
/** @typedef {import("../identity/commands.js").Actor} Actor */
/** @typedef {import("../identity/commands.js").AuditContext} AuditContext */
/** @typedef {import("../identity/permissions.js").Scope} Scope */

/** @param {express.Response} response @param {unknown} result */
function reply(response, result) {
  response.json({ statusCode: 200, message: "موفق", result });
}
/** @param {Actor} actor @param {string} permission */
function gate(actor, permission) {
  if (!actor.grant.permissions.includes(permission))
    throw new ApiError(403, "FORBIDDEN", "دسترسی به این بخش مجاز نیست.");
}
/** @param {{_id:import("mongodb").ObjectId}} row @param {Scope} scope */
function output(row, scope) {
  return {
    id: String(row._id),
    output: publicRow(row),
    scopes: [scope],
    audit: publicRow(row),
  };
}

/** @param {Identity} identity @param {(request:express.Request,response:express.Response)=>Promise<Actor>} authenticate @param {(response:express.Response,module:string,action:string)=>AuditContext} audit */
export function defectsRouter(identity, authenticate, audit) {
  const store = assemblyStore(identity.database);
  const router = express.Router();
  const command = transactionCommands(
    identity,
    store.assemblyCommands,
    authenticate,
    audit,
    "defects",
    conflict,
  );
  const quality = transactionCommands(
    identity,
    store.assemblyCommands,
    authenticate,
    audit,
    "stageQc",
    conflict,
  );

  router.get("/cases", async (req, res) => {
    const actor = await authenticate(req, res);
    const technical = req.query.technical === "true";
    const replacements = req.query.replacements === "true";
    gate(actor, technical || replacements ? "stageQc:view" : "defects:view");
    const { skip, size } = pageInput(req.query);
    const filter = {
      ...scopeQuery(actor.grant),
      ...(technical
        ? {
            status: {
              $in: /** @type {import("./store.js").CaseStatus[]} */ ([
                "technical",
                "escalated",
              ]),
            },
          }
        : {}),
      ...(replacements ? { replacementId: { $exists: true } } : {}),
    };
    const [items, count] = await Promise.all([
      store.defects
        .find(filter)
        .sort({ at: -1, _id: -1 })
        .skip(skip)
        .limit(size)
        .toArray(),
      store.defects.countDocuments(filter),
    ]);
    reply(res, { items: items.map(publicRow), count });
  });

  router.get("/cases/:id", async (req, res) => {
    const actor = await authenticate(req, res);
    const defect = await loadCase(store, req.params.id);
    const can = (/** @type {string} */ permission) =>
      hasPermission(actor.grant, permission, defect.scope);
    if (
      ![
        "defects:view",
        "stageQc:view",
        "assembly:view",
        ...Object.values(caseActions),
      ].some(can)
    )
      throw new ApiError(403, "FORBIDDEN", "دسترسی به پرونده مجاز نیست.");
    const data = await caseDetail(store, defect);
    const owner = data.visit.enteredBy === String(actor.user._id);
    reply(res, {
      ...data,
      access: {
        decide:
          !owner &&
          defect.actorId !== String(actor.user._id) &&
          can(caseActions.decide),
        label: owner && can(caseActions.label),
        install: owner && can(caseActions.install),
        rework: owner && can(caseActions.rework),
        cancelLabel: owner && can(caseActions.cancelLabel),
      },
    });
  });

  for (const technical of [false, true]) {
    const run = technical ? quality : command;
    router.post(
      "/visits/:id/" + (technical ? "refer" : "declare"),
      run(
        technical ? "defect.refer" : "defect.declare",
        technical ? "stageQc:create" : "defects:create",
        async (actor, req, session) => {
          const row = await openCase(
            store,
            await loadVisit(store, req.params.id, session),
            technical,
            actor,
            fields(req.body),
            session,
          );
          return output(row, row.scope);
        },
      ),
    );
  }

  for (const action of /** @type {(keyof typeof caseActions)[]} */ (
    Object.keys(caseActions)
  )) {
    const run = action === "decide" ? quality : command;
    router.post(
      "/cases/:id/" + action,
      run(
        "defect." + action,
        caseActions[action],
        async (actor, req, session) => {
          const row = await updateCase(
            store,
            await loadCase(store, req.params.id, session),
            action,
            actor,
            fields(req.body),
            session,
          );
          return output(row, row.scope);
        },
      ),
    );
  }

  router.get("/cases/:id/label", async (req, res) => {
    const actor = await authenticate(req, res);
    const defect = await loadCase(store, req.params.id);
    requirePermission(actor.grant, "assembly:create", defect.scope);
    if (!defect.replacementId) throw missing();
    const part = await store.parts.findOne({
      _id: objectId(defect.replacementId),
      state: { $in: ["replacement_reserved", "installed"] },
    });
    if (!part) throw missing();
    res
      .type("png")
      .set("Cache-Control", "private, no-store")
      .set("X-Content-Type-Options", "nosniff")
      .send(
        await bwip.toBuffer({
          bcid: "code128",
          text: part.code,
          scale: 3,
          height: 12,
        }),
      );
  });

  router.get("/parts", async (req, res) => {
    const actor = await authenticate(req, res);
    gate(actor, "defects:view");
    const { skip, size } = pageInput(req.query);
    const allowed = scopeQuery(actor.grant);
    const [result] = await store.parts
      .aggregate([
        {
          $match: {
            state: { $in: ["defective", "defect_store", "supplier_return"] },
          },
        },
        { $set: { "scope.warehouseId": "$warehouseId" } },
        { $match: allowed },
        {
          $facet: {
            count: [{ $count: "value" }],
            items: [{ $sort: { _id: -1 } }, { $skip: skip }, { $limit: size }],
          },
        },
      ])
      .toArray();
    reply(res, {
      canPrint:
        (result?.items ?? []).length > 0 &&
        (result?.items ?? []).every(
          (/** @type {import("../basket/store.js").Part} */ row) =>
            hasPermission(actor.grant, "defects:pdf", returnScope(row)),
        ),
      count: result?.count[0]?.value ?? 0,
      items: (result?.items ?? []).map(
        (/** @type {import("../basket/store.js").Part} */ row) => ({
          ...publicPart(row),
          canSelect: hasPermission(
            actor.grant,
            "defects:create",
            returnScope(row),
          ),
        }),
      ),
    });
  });
  router.post(
    "/receive",
    command("defect.receive", "defects:scan", async (actor, req, session) => {
      const part = await receive(store, actor, fields(req.body), session);
      return {
        id: String(part._id),
        output: publicPart(part),
        scopes: [returnScope(part)],
        audit: { state: part.state, defectId: part.defectId },
      };
    }),
  );

  router.get("/returns", async (req, res) => {
    const actor = await authenticate(req, res);
    gate(actor, "defects:view");
    const { skip, size } = pageInput(req.query);
    const filter = scopeQuery(actor.grant);
    const [items, count] = await Promise.all([
      store.returns
        .find(filter)
        .sort({ at: -1, _id: -1 })
        .skip(skip)
        .limit(size)
        .toArray(),
      store.returns.countDocuments(filter),
    ]);
    reply(res, { items: items.map(publicRow), count });
  });
  router.get("/returns/:id", async (req, res) => {
    const actor = await authenticate(req, res);
    const row = await loadReturn(store, req.params.id);
    requirePermission(actor.grant, "defects:view", row.scope);
    reply(res, {
      ...publicRow(row),
      canTransfer: hasPermission(actor.grant, "defects:transfer", row.scope),
      canPrint: hasPermission(actor.grant, "defects:pdf", row.scope),
    });
  });
  router.post(
    "/returns",
    command(
      "defect.return.create",
      "defects:create",
      async (actor, req, session) => {
        const row = await createReturn(store, actor, fields(req.body), session);
        return output(row, row.scope);
      },
    ),
  );
  router.post(
    "/returns/:id/advance",
    command(
      "defect.return.advance",
      "defects:transfer",
      async (actor, req, session) => {
        const row = await advanceReturn(
          store,
          await loadReturn(store, req.params.id, session),
          actor,
          fields(req.body),
          session,
        );
        return output(row, row.scope);
      },
    ),
  );
  return router;
}
