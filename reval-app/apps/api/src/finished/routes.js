import express from "express";
import bwip from "@bwip-js/node";
import { assemblyStore } from "../assembly/store.js";
import { conflict, missing } from "../assembly/workflow.js";
import { ApiError } from "../http-error.js";
import { transactionCommands } from "../identity/commands.js";
import { hasPermission, requirePermission } from "../identity/permissions.js";
import { fields, objectId, pageInput } from "../identity/validation.js";
import { publicRow } from "../imei/store.js";
import { filterSearch, scopeQuery } from "../inventory/queries.js";
import {
  cartonActions,
  changeCarton,
  createCarton,
  loadCarton,
} from "./cartons.js";
import {
  changeQuality,
  loadQuality,
  qualityActions,
  qualityDetail,
} from "./quality.js";

/** @typedef {import("../identity/commands.js").Identity} Identity */
/** @typedef {import("../identity/commands.js").Actor} Actor */
/** @typedef {import("../identity/commands.js").AuditContext} AuditContext */
/** @typedef {import("../identity/permissions.js").Scope} Scope */

/** @param {express.Response} res @param {unknown} result */
function reply(res, result) {
  res.json({ statusCode: 200, message: "موفق", result });
}
/** @param {Actor} actor @param {string} permission */
function gate(actor, permission) {
  if (!actor.grant.permissions.includes(permission))
    throw new ApiError(403, "FORBIDDEN", "دسترسی به این بخش مجاز نیست.");
}
/** @param {express.Response} res @param {string} code */
async function barcode(res, code) {
  res
    .type("png")
    .set("Cache-Control", "private, no-store")
    .set("X-Content-Type-Options", "nosniff")
    .send(
      await bwip.toBuffer({
        bcid: "code128",
        text: code,
        scale: 3,
        height: 12,
      }),
    );
}
/** @param {{_id:import("mongodb").ObjectId}} row @param {Scope} scope */
function result(row, scope) {
  return {
    id: String(row._id),
    scopes: [scope],
    output: publicRow(row),
    audit: publicRow(row),
  };
}

/** @param {Identity} identity @param {(request:express.Request,response:express.Response)=>Promise<Actor>} authenticate @param {(response:express.Response,module:string,action:string)=>AuditContext} audit */
export function qualityRouter(identity, authenticate, audit) {
  const store = assemblyStore(identity.database),
    router = express.Router();
  const command = transactionCommands(
    identity,
    store.assemblyCommands,
    authenticate,
    audit,
    "finalQc",
    conflict,
  );
  router.get("/", async (req, res) => {
    const actor = await authenticate(req, res);
    gate(actor, "finalQc:view");
    const { skip, size } = pageInput(req.query);
    const q = req.query.q ? filterSearch(req.query.q) : null;
    const modelId = req.query.modelId
      ? String(objectId(req.query.modelId))
      : undefined;
    const filtered = {
      ...(modelId ? { modelId } : {}),
      ...(q
        ? { $or: [{ unitCode: q }, { "unit.numbers": q }, { lineName: q }] }
        : {}),
    };
    const view =
      req.query.view === "packing"
        ? { qualityStatus: { $in: ["passed", "packed"] } }
        : req.query.view === "testing"
          ? { qualityStatus: { $in: ["testing", "rework"] } }
          : {};
    const [data] = await store.baskets
      .aggregate([
        { $match: { status: "received", ...scopeQuery(actor.grant) } },
        {
          $set: {
            unitKey: { $toObjectId: "$unitId" },
            routeKey: { $toObjectId: "$routingVersionId" },
          },
        },
        {
          $lookup: {
            from: store.imei.units.collectionName,
            localField: "unitKey",
            foreignField: "_id",
            as: "unit",
          },
        },
        { $unwind: "$unit" },
        { $match: { "unit.state": "allocated" } },
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
            as: "route",
          },
        },
        { $unwind: "$route" },
        {
          $lookup: {
            from: store.final.collectionName,
            localField: "unitKey",
            foreignField: "_id",
            as: "final",
          },
        },
        { $unwind: { path: "$final", preserveNullAndEmptyArrays: true } },
        {
          $match: {
            $or: [
              { "final.status": "rework" },
              { $expr: { $eq: ["$position.next", { $size: "$route.steps" }] } },
            ],
          },
        },
        { $set: { qualityStatus: { $ifNull: ["$final.status", "testing"] } } },
        {
          $facet: {
            models: [
              { $group: { _id: "$modelId", name: { $first: "$modelName" } } },
              { $sort: { name: 1 } },
              { $project: { _id: 0, id: "$_id", name: 1 } },
            ],
            statuses: [
              { $match: filtered },
              { $group: { _id: "$qualityStatus", count: { $sum: 1 } } },
            ],
            count: [{ $match: { ...filtered, ...view } }, { $count: "value" }],
            items: [
              { $match: { ...filtered, ...view } },
              { $sort: { receivedAt: -1, _id: -1 } },
              { $skip: skip },
              { $limit: size },
              {
                $project: {
                  _id: 0,
                  id: "$unitId",
                  code: "$unitCode",
                  modelName: 1,
                  colorName: 1,
                  lineName: 1,
                  status: "$qualityStatus",
                },
              },
            ],
          },
        },
      ])
      .toArray();
    reply(res, {
      items: data?.items ?? [],
      models: data?.models ?? [],
      count: data?.count[0]?.value ?? 0,
      statuses: Object.fromEntries(
        (data?.statuses ?? []).map(
          (/** @type {{_id:string,count:number}} */ row) => [
            row._id,
            row.count,
          ],
        ),
      ),
    });
  });
  router.get("/:id", async (req, res) => {
    const actor = await authenticate(req, res);
    const data = await loadQuality(store, req.params.id);
    const access = Object.fromEntries(
      Object.entries(qualityActions).map(([action, permission]) => [
        action,
        hasPermission(actor.grant, permission, data.unit.scope),
      ]),
    );
    reply(res, { ...(await qualityDetail(store, data, actor)), access });
  });
  router.get("/:id/label/:slot", async (req, res) => {
    const actor = await authenticate(req, res);
    const data = await loadQuality(store, req.params.id);
    requirePermission(actor.grant, "finalQc:create", data.unit.scope);
    const slot = Number(req.params.slot);
    const code =
      Number.isInteger(slot) && slot >= 1
        ? data.unit.numbers[slot - 1]
        : undefined;
    if (
      !code ||
      !data.unit.qcPassedAt ||
      data.record?.labelPairId !== data.unit.pairId
    )
      throw missing();
    await barcode(res, code);
  });
  for (const action of /** @type {(keyof typeof qualityActions)[]} */ (
    Object.keys(qualityActions)
  )) {
    router.post(
      "/:id/" + action,
      command(
        "final." + action,
        qualityActions[action],
        async (actor, req, session) => {
          const data = await loadQuality(store, req.params.id, session);
          return result(
            await changeQuality(
              store,
              data,
              action,
              actor,
              fields(req.body),
              session,
            ),
            data.unit.scope,
          );
        },
      ),
    );
  }
  return router;
}

/** @param {Identity} identity @param {(request:express.Request,response:express.Response)=>Promise<Actor>} authenticate @param {(response:express.Response,module:string,action:string)=>AuditContext} audit */
export function finishedRouter(identity, authenticate, audit) {
  const store = assemblyStore(identity.database),
    router = express.Router();
  const command = transactionCommands(
    identity,
    store.assemblyCommands,
    authenticate,
    audit,
    "finished",
    conflict,
  );
  router.get("/options", async (req, res) => {
    const actor = await authenticate(req, res);
    gate(actor, "finished:view");
    const [warehouses, models, colors] = await Promise.all([
      store.catalog.records
        .find({
          kind: "warehouses",
          active: true,
          "data.purpose": "finished",
          ...scopeQuery(actor.grant),
        })
        .sort({ name: 1 })
        .toArray(),
      store.catalog.records
        .find({ kind: "models", active: true })
        .sort({ name: 1 })
        .toArray(),
      store.catalog.records
        .find({ kind: "colors", active: true })
        .sort({ name: 1 })
        .toArray(),
    ]);
    reply(res, {
      warehouses: warehouses.map((row) => ({
        id: String(row._id),
        name: row.name,
        canCreate: hasPermission(actor.grant, "finished:create", row.scope),
      })),
      models: models.map((row) => ({
        id: String(row._id),
        name: row.name,
        colorIds: row.data.colorIds,
      })),
      colors: colors.map((row) => ({ id: String(row._id), name: row.name })),
    });
  });
  router.get("/cartons", async (req, res) => {
    const actor = await authenticate(req, res);
    gate(actor, "finished:view");
    const { skip, size } = pageInput(req.query);
    const q = req.query.q ? filterSearch(req.query.q) : null;
    const states =
      req.query.tab === "stock"
        ? ["placed"]
        : req.query.tab === "placement"
          ? ["closed", "placed"]
          : ["open"];
    const filter = {
      $and: [
        scopeQuery(actor.grant),
        {
          status: {
            $in: /** @type {import("./store.js").Carton["status"][]} */ (
              states
            ),
          },
        },
        q
          ? req.query.by === "imei"
            ? { "members.numbers": q }
            : { code: q }
          : {},
      ],
    };
    const [rows, count] = await Promise.all([
      store.finishedCartons
        .find(filter)
        .sort({ _id: -1 })
        .skip(skip)
        .limit(size)
        .toArray(),
      store.finishedCartons.countDocuments(filter),
    ]);
    reply(res, {
      items: rows.map(publicRow),
      count,
      canPrint:
        rows.length > 0 &&
        rows.every((row) =>
          hasPermission(actor.grant, "finished:pdf", row.scope),
        ),
    });
  });
  router.get("/cartons/:id", async (req, res) => {
    const actor = await authenticate(req, res),
      carton = await loadCarton(store, req.params.id);
    requirePermission(actor.grant, "finished:view", carton.scope);
    const locations = await store.catalog.records
      .find({
        kind: "locations",
        active: true,
        "scope.warehouseId": carton.scope.warehouseId,
      })
      .sort({ code: 1 })
      .toArray();
    const access = Object.fromEntries(
      Object.entries(cartonActions).map(([action, permission]) => [
        action,
        hasPermission(actor.grant, permission, carton.scope),
      ]),
    );
    reply(res, {
      carton: publicRow(carton),
      locations: locations.map((row) => ({
        id: String(row._id),
        name: row.name,
        code: row.code,
      })),
      access,
    });
  });
  router.get("/cartons/:id/label", async (req, res) => {
    const actor = await authenticate(req, res),
      carton = await loadCarton(store, req.params.id);
    requirePermission(actor.grant, "finished:create", carton.scope);
    if (
      !carton.labelVersion ||
      (carton.status === "open" && carton.labelVersion !== carton.version)
    )
      throw missing();
    await barcode(res, carton.code);
  });
  router.post(
    "/cartons",
    command(
      "finished.create",
      "finished:create",
      async (actor, req, session) => {
        const row = await createCarton(store, actor, fields(req.body), session);
        return result(row, row.scope);
      },
    ),
  );
  for (const action of /** @type {(keyof typeof cartonActions)[]} */ (
    Object.keys(cartonActions)
  )) {
    router.post(
      "/cartons/:id/" + action,
      command(
        "finished." + action,
        cartonActions[action],
        async (actor, req, session) => {
          const row = await changeCarton(
            store,
            await loadCarton(store, req.params.id, session),
            action,
            actor,
            fields(req.body),
            session,
          );
          return result(row, row.scope);
        },
      ),
    );
  }
  return router;
}
