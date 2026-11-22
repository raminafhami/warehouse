import express from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { assemblyStore } from "../assembly/store.js";
import { ApiError } from "../http-error.js";
import { badInput, objectId, pageInput } from "../identity/validation.js";
import { filterSearch } from "../inventory/queries.js";
import {
  cell,
  dashboard,
  filters,
  ledgerSnapshot,
  lineOptions,
  reportCursor,
  reportIds,
  reportPage,
  reportOverview,
} from "./report.js";
import { kinds, searchTrace, traceDetail, traceModes } from "./trace.js";

/** @typedef {import("../identity/commands.js").Identity} Identity */
/** @typedef {import("../identity/commands.js").Actor} Actor */
/** @param {Actor} actor @param {string} permission */
function gate(actor, permission) {
  if (!actor.grant.permissions.includes(permission))
    throw new ApiError(403, "FORBIDDEN", "دسترسی به این گزارش مجاز نیست.");
}
/** @param {express.Response} res @param {unknown} result */
function reply(res, result) {
  res
    .set("Cache-Control", "private, no-store")
    .json({ statusCode: 200, message: "موفق", result });
}
/** @param {string} value */
function quote(value) {
  const first = [...value].find(
    (character) => character.charCodeAt(0) > 32 && character.trim(),
  );
  const escaped =
    first && "=+@-".includes(first) && !/^-\d+(?:\.\d+)?$/.test(value)
      ? "'" + value
      : value;
  return '"' + escaped.replaceAll('"', '""') + '"';
}
/** @param {ReturnType<typeof reportCursor>} report */
async function* csv(report) {
  yield (
    "\uFEFF" +
    report.columns.map((column) => quote(column.label)).join(",") +
    "\r\n"
  );
  const cursor = report.collection.aggregate(
    [
      ...report.pipeline,
      { $sort: report.order },
      { $project: report.projection },
    ],
    { allowDiskUse: true },
  );
  try {
    for await (const row of cursor)
      yield (
        report.columns
          .map((_, index) => quote(cell(row["f" + index])))
          .join(",") + "\r\n"
      );
  } finally {
    await cursor.close();
  }
}

/** @param {Identity} identity @param {(request:express.Request,response:express.Response)=>Promise<Actor>} authenticate */
export function insightsRouter(identity, authenticate) {
  const router = express.Router(),
    store = assemblyStore(identity.database);
  router.get("/dashboard", async (req, res) => {
    const actor = await authenticate(req, res);
    gate(actor, "dashboard:view");
    if (req.query.print === "true") gate(actor, "dashboard:pdf");
    const filter = filters(req.query);
    const [lines, data] = await Promise.all([
      lineOptions(store, actor.grant),
      dashboard(store, actor.grant, filter),
    ]);
    reply(res, {
      lines,
      ...data,
      canPrint: actor.grant.permissions.includes("dashboard:pdf"),
    });
  });
  router.get("/reports", async (req, res) => {
    const actor = await authenticate(req, res);
    gate(actor, "reports:view");
    if (req.query.print === "true") gate(actor, "reports:pdf");
    const kind = req.query.kind ?? "shipments";
    if (typeof kind !== "string" || !reportIds.includes(kind)) throw badInput();
    const filter = filters(req.query);
    const { skip, size } = pageInput(req.query);
    const report = reportCursor(store, actor.grant, filter, kind, skip, size);
    if (req.query.export === "csv") {
      gate(actor, "reports:report");
      res
        .type("text/csv; charset=utf-8")
        .attachment("reval-" + kind + ".csv")
        .set("Cache-Control", "private, no-store");
      await pipeline(Readable.from(csv(report)), res);
      return;
    }
    const [lines, data, snapshot] = await Promise.all([
      lineOptions(store, actor.grant),
      reportPage(report),
      kind === "ledger" &&
      !filter.lineId &&
      !filter.q &&
      filter.period === "all"
        ? identity.database.transaction(
            (session) => ledgerSnapshot(store, actor.grant, session),
            { readConcern: { level: "snapshot" } },
          )
        : null,
    ]);
    reply(res, {
      ...data,
      lines,
      snapshot,
      canPrint: actor.grant.permissions.includes("reports:pdf"),
      canExport: actor.grant.permissions.includes("reports:report"),
    });
  });
  router.get("/reports/overview", async (req, res) => {
    const actor = await authenticate(req, res);
    gate(actor, "reports:view");
    reply(res, await reportOverview(store, actor.grant, filters(req.query)));
  });
  router.get("/trace/options", async (req, res) => {
    const actor = await authenticate(req, res);
    gate(actor, "trace:view");
    const types = await store.catalog.records
      .find({ kind: "partTypes" }, { projection: { name: 1, code: 1 } })
      .sort({ name: 1, _id: 1 })
      .toArray();
    reply(
      res,
      types.map((row) => ({
        id: String(row._id),
        name: row.name,
        code: row.code,
      })),
    );
  });
  router.get("/trace", async (req, res) => {
    const actor = await authenticate(req, res);
    gate(actor, "trace:view");
    const mode = req.query.mode ?? "";
    if (typeof mode !== "string" || (mode && !Object.hasOwn(traceModes, mode)))
      throw badInput();
    const modeKind = traceModes[/** @type {keyof typeof traceModes} */ (mode)];
    const requested = req.query.kind ?? "all";
    if (modeKind && requested !== "all" && requested !== modeKind)
      throw badInput();
    const kind = modeKind ?? requested;
    if (req.query.partTypeId && kind !== "material") throw badInput();
    const partTypeId = req.query.partTypeId
      ? String(objectId(req.query.partTypeId))
      : undefined;
    if (typeof kind !== "string" || (kind !== "all" && !kinds.includes(kind)))
      throw badInput();
    const { skip, size } = pageInput(req.query);
    reply(
      res,
      req.query.q || mode || partTypeId
        ? await searchTrace(
            store,
            actor.grant,
            kind,
            req.query.q ? filterSearch(req.query.q) : null,
            skip,
            size,
            { mode, partTypeId },
          )
        : [],
    );
  });
  router.get("/trace/:kind/:id", async (req, res) => {
    const actor = await authenticate(req, res);
    gate(actor, "trace:view");
    if (!kinds.includes(req.params.kind)) throw badInput();
    const data = await traceDetail(
      store,
      actor.grant,
      req.params.kind,
      req.params.id,
    );
    reply(res, data);
  });
  return router;
}
