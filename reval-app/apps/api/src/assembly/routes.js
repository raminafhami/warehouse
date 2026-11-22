import express from "express";
import { ApiError } from "../http-error.js";
import { transactionCommands } from "../identity/commands.js";
import { hasPermission, requirePermission } from "../identity/permissions.js";
import {
  badInput,
  fields,
  objectId,
  pageInput,
} from "../identity/validation.js";
import { publicRow } from "../imei/store.js";
import { filterSearch, scopeQuery } from "../inventory/queries.js";
import { assemblyStore } from "./store.js";
import {
  act,
  conflict,
  detail,
  enter,
  loadVisit,
  missing,
  permissions,
} from "./workflow.js";

/** @typedef {import("../identity/commands.js").Identity} Identity */
/** @typedef {import("../identity/commands.js").Actor} Actor */
/** @typedef {import("../identity/commands.js").AuditContext} AuditContext */

/** @param {express.Response} response @param {unknown} result */
const reply = (response, result) =>
  response.json({ statusCode: 200, message: "موفق", result });
/** @param {Actor} actor @param {string} permission */
function requireAction(actor, permission) {
  if (!actor.grant.permissions.includes(permission))
    throw new ApiError(403, "FORBIDDEN", "دسترسی به این گزارش مجاز نیست.");
}

/** @param {Identity} identity @param {(request:express.Request,response:express.Response)=>Promise<Actor>} authenticate @param {(response:express.Response,module:string,action:string)=>AuditContext} audit */
export function assemblyRouter(identity, authenticate, audit) {
  const store = assemblyStore(identity.database);
  const router = express.Router();
  const assembly = transactionCommands(
    identity,
    store.assemblyCommands,
    authenticate,
    audit,
    "assembly",
    conflict,
  );
  const stageQc = transactionCommands(
    identity,
    store.assemblyCommands,
    authenticate,
    audit,
    "stageQc",
    conflict,
  );

  router.get("/options", async (request, response) => {
    const actor = await authenticate(request, response);
    requireAction(actor, "assembly:view");
    const stations = await store.catalog.records
      .find({ kind: "stations", ...scopeQuery(actor.grant) })
      .sort({ "scope.lineId": 1, "data.order": 1, code: 1 })
      .toArray();
    const lineIds = [
      ...new Set(
        stations.flatMap((station) =>
          station.scope.lineId ? [station.scope.lineId] : [],
        ),
      ),
    ];
    const lines = await store.catalog.records
      .find({ kind: "lines", _id: { $in: lineIds.map(objectId) } })
      .toArray();
    const assigned = new Map(
      lines.map((line) => [String(line._id), line.name]),
    );
    reply(
      response,
      stations.map((station) => ({
        id: String(station._id),
        code: station.code,
        name: station.name,
        lineId: station.scope.lineId,
        lineName: assigned.get(station.scope.lineId ?? "") ?? "",
      })),
    );
  });

  router.get("/queue", async (request, response) => {
    const actor = await authenticate(request, response);
    if (!request.query.stationId) {
      requireAction(actor, "assembly:view");
      return reply(response, {
        items: [],
        models: [],
        count: 0,
        access: { scan: false, pdf: false },
      });
    }
    const station = await store.catalog.records.findOne({
      _id: objectId(request.query.stationId),
      kind: "stations",
    });
    if (!station) throw missing();
    requirePermission(actor.grant, "assembly:view", station.scope);
    const { skip, size } = pageInput(request.query);
    const stationId = String(station._id);
    const modelId = request.query.modelId
      ? String(objectId(request.query.modelId))
      : undefined;
    const [result] = await store.baskets
      .aggregate([
        { $match: { status: "received", lineId: station.scope.lineId } },
        {
          $set: {
            unitKey: { $toObjectId: "$unitId" },
            routeKey: { $toObjectId: "$routingVersionId" },
            "scope.stationId": stationId,
          },
        },
        { $match: scopeQuery(actor.grant) },
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
            "unit.state": "allocated",
            "unit.imeiError": { $exists: false },
            $expr: { $eq: ["$unit.pairId", "$confirmedPairId"] },
          },
        },
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
            from: store.positions.collectionName,
            localField: "unitKey",
            foreignField: "_id",
            as: "position",
          },
        },
        { $unwind: { path: "$position", preserveNullAndEmptyArrays: true } },
        {
          $set: {
            step: {
              $arrayElemAt: [
                "$route.steps",
                { $ifNull: ["$position.next", 0] },
              ],
            },
          },
        },
        { $match: { "step.stationId": stationId } },
        {
          $facet: {
            models: [
              { $group: { _id: "$modelId", name: { $first: "$modelName" } } },
              { $sort: { name: 1 } },
            ],
            count: [
              ...(modelId ? [{ $match: { modelId } }] : []),
              { $count: "value" },
            ],
            items: [
              ...(modelId ? [{ $match: { modelId } }] : []),
              { $sort: { receivedAt: 1, _id: 1 } },
              { $skip: skip },
              { $limit: size },
              {
                $lookup: {
                  from: store.visits.collectionName,
                  localField: "position.visitId",
                  foreignField: "_id",
                  as: "visit",
                },
              },
              {
                $unwind: {
                  path: "$visit",
                  preserveNullAndEmptyArrays: true,
                },
              },
              {
                $project: {
                  _id: 0,
                  id: { $toString: "$_id" },
                  unitCode: 1,
                  modelName: 1,
                  orderCode: 1,
                  receivedAt: 1,
                  status: { $ifNull: ["$visit.status", "queued"] },
                  visitId: { $toString: "$visit._id" },
                },
              },
            ],
          },
        },
      ])
      .toArray();
    reply(response, {
      models:
        result?.models.map((/** @type {{_id:string,name:string}} */ row) => ({
          id: row._id,
          name: row.name,
        })) ?? [],
      items: result?.items ?? [],
      count: result?.count[0]?.value ?? 0,
      access: {
        scan: hasPermission(actor.grant, "assembly:scan", station.scope),
        pdf: hasPermission(actor.grant, "assembly:pdf", station.scope),
      },
    });
  });

  router.get("/testing", async (request, response) => {
    const actor = await authenticate(request, response);
    requireAction(actor, "stageQc:view");
    const { skip, size } = pageInput(request.query);
    const filter = {
      status: /** @type {const} */ ("testing"),
      ...scopeQuery(actor.grant),
    };
    const [items, count] = await Promise.all([
      store.visits
        .find(filter)
        .sort({ completedAt: 1, _id: 1 })
        .skip(skip)
        .limit(size)
        .toArray(),
      store.visits.countDocuments(filter),
    ]);
    reply(response, { items: items.map(publicRow), count });
  });

  router.get("/results", async (request, response) => {
    const actor = await authenticate(request, response);
    requireAction(actor, "stageQc:view");
    const { skip, size } = pageInput(request.query);
    const outcome = request.query.outcome;
    const tab = request.query.tab ?? "results";
    if (
      (outcome &&
        !["pass", "fail", "review"].some((item) => item === outcome)) ||
      !["results", "retests", "rates"].some((item) => item === tab)
    )
      throw badInput();
    const search = request.query.q ? filterSearch(request.query.q) : null;
    const filter = {
      $and: [
        scopeQuery(actor.grant),
        search
          ? {
              $or: [
                { unitCode: search },
                { testName: search },
                { stationName: search },
              ],
            }
          : {},
      ],
    };
    const rows =
      tab === "rates"
        ? [
            { $sort: { visitId: 1, testId: 1, attempt: 1, revision: -1 } },
            {
              $group: {
                _id: {
                  visitId: "$visitId",
                  testId: "$testId",
                  attempt: "$attempt",
                },
                latest: { $first: "$$ROOT" },
              },
            },
            {
              $group: {
                _id: {
                  testId: "$latest.testId",
                  name: "$latest.testName",
                  routingVersionId: "$latest.routingVersionId",
                },
                total: { $sum: 1 },
                failed: {
                  $sum: { $cond: [{ $eq: ["$latest.outcome", "fail"] }, 1, 0] },
                },
                review: {
                  $sum: {
                    $cond: [{ $eq: ["$latest.outcome", "review"] }, 1, 0],
                  },
                },
              },
            },
            {
              $sort: {
                "_id.name": 1,
                "_id.testId": 1,
                "_id.routingVersionId": 1,
              },
            },
          ]
        : [
            {
              $match: {
                ...(outcome ? { outcome } : {}),
                ...(tab === "retests" ? { attempt: { $gt: 1 } } : {}),
              },
            },
            { $sort: { at: -1, _id: -1 } },
          ];
    const [result] = await store.results
      .aggregate([
        { $match: filter },
        ...rows,
        {
          $facet: {
            count: [{ $count: "value" }],
            items: [{ $skip: skip }, { $limit: size }],
          },
        },
      ])
      .toArray();
    const items =
      tab === "rates"
        ? (result?.items ?? [])
        : (result?.items ?? []).map(publicRow);
    reply(response, { items, count: result?.count[0]?.value ?? 0 });
  });

  router.post(
    "/entry",
    assembly("entry", "assembly:scan", async (actor, request, session) => {
      const visit = await enter(store, actor, fields(request.body), session);
      return {
        id: String(visit._id),
        scopes: [visit.scope],
        output: { visit: publicRow(visit) },
        audit: { unitId: visit.unitId, stationCode: visit.stationCode },
      };
    }),
  );
  router.get("/visits/:id", async (request, response) => {
    const actor = await authenticate(request, response);
    reply(
      response,
      await detail(store, await loadVisit(store, request.params.id), actor),
    );
  });
  for (const action of /** @type {(keyof typeof permissions)[]} */ (
    Object.keys(permissions)
  )) {
    const commands =
      action === "test" || action === "correct" ? stageQc : assembly;
    router.post(
      "/visits/:id/" + action,
      commands(action, permissions[action], async (actor, request, session) => {
        const visit = await loadVisit(store, request.params.id, session);
        const output = await act(
          store,
          visit,
          action,
          actor,
          fields(request.body),
          session,
        );
        return {
          id: String(visit._id),
          scopes: [visit.scope],
          output,
          audit: {
            unitId: visit.unitId,
            stationCode: visit.stationCode,
            ...output,
          },
        };
      }),
    );
  }
  return router;
}
