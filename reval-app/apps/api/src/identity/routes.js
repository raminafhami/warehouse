import { randomUUID } from "node:crypto";
import { catalogRouter } from "../catalog/routes.js";
import { catalogStore } from "../catalog/store.js";
import { shipmentsRouter } from "../shipments/routes.js";
import { inventoryRouter } from "../inventory/routes.js";
import { insightsRouter } from "../insights/routes.js";
import { finishedRouter, qualityRouter } from "../finished/routes.js";
import { defectsRouter } from "../defects/routes.js";
import { assemblyRouter } from "../assembly/routes.js";
import { basketRouter } from "../basket/routes.js";
import { imeiRouter } from "../imei/routes.js";
import { handoverRouter } from "../handover/routes.js";
import express from "express";
import { ApiError } from "../http-error.js";
import {
  actions,
  hasPermission,
  modules,
  requirePermission,
} from "./permissions.js";
import { appendAudit } from "./audit.js";
import {
  conflict,
  createUser,
  identityError,
  notFound,
  updateUser,
} from "./users.js";
import {
  cookieValue,
  identify,
  issueSession,
  sessionToken,
  validatePasswordChange,
  verifyLogin,
} from "./sessions.js";
import { publicUser } from "./store.js";
import {
  badInput,
  fields,
  objectId,
  pageInput,
  permissionInput,
  text,
} from "./validation.js";

/** @typedef {ReturnType<typeof import("./store.js").identityStore>} Store */
/** @typedef {Awaited<ReturnType<typeof identify>>} Actor */
/** @typedef {import("express").Request} Request */
/** @typedef {import("express").Response} Response */
/** @typedef {import("./store.js").Audit} Audit */

/** @param {Response} response @param {unknown} result @param {number} [status] */
function reply(response, result, status = 200) {
  response.status(status).json({ statusCode: status, message: "موفق", result });
}

/** @param {unknown} value */
function searchInput(value) {
  if (value === undefined || value === "") return undefined;
  return new RegExp(
    text(value, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "i",
  );
}

/** @param {Store} store @param {{ origin: string, ttl: number, demo?:boolean, loopbackAlias?:string }} options */
export function identityRouter(
  store,
  { origin, ttl, demo = false, loopbackAlias = origin },
) {
  const router = express.Router();
  const secure = origin.startsWith("https://");
  const origins = [origin, loopbackAlias];
  /** @type {Map<string, { count: number, expiresAt: number }>} */
  const attempts = new Map();

  router.use(
    [
      "/auth",
      "/users",
      "/roles",
      "/audit",
      "/master",
      "/shipments",
      "/inventory",
      "/handover",
    ],
    (request, response, next) => {
      response.set("Cache-Control", "no-store");
      if (
        !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
        !origins.includes(request.get("Origin") ?? "")
      ) {
        next(new ApiError(403, "INVALID_ORIGIN", "مبدأ درخواست معتبر نیست."));
        return;
      }
      next();
    },
  );

  /** @param {Request} request @param {Response} response @param {boolean} [allowInitialPassword] */
  async function authenticate(request, response, allowInitialPassword = false) {
    const actor = await identify(store, sessionToken(request.headers.cookie));
    response.locals.actor = actor;
    if (!allowInitialPassword && actor.user.mustChangePassword) {
      throw new ApiError(
        403,
        "PASSWORD_CHANGE_REQUIRED",
        "ابتدا رمز اولیه را تغییر دهید.",
      );
    }
    return actor;
  }

  /** @param {Response} response @param {string} module @param {string} action */
  function event(response, module, action) {
    response.locals.auditAction = { module, action };
    return {
      actor: response.locals.actor?.user ?? null,
      module,
      action,
      correlationId: String(response.locals.correlationId),
    };
  }

  router.post("/auth/login", async (request, response) => {
    const context = event(response, "auth", "login");
    const key = request.ip ?? "unknown";
    const now = Date.now();
    for (const [address, attempt] of attempts)
      if (attempt.expiresAt <= now) attempts.delete(address);
    const attempt = attempts.get(key) ?? { count: 0, expiresAt: now + 60000 };
    if ((!attempts.has(key) && attempts.size >= 10000) || attempt.count >= 15) {
      throw new ApiError(
        429,
        "LOGIN_RATE_LIMITED",
        "تلاش‌های ورود زیاد است. کمی بعد دوباره تلاش کنید.",
      );
    }
    attempt.count += 1;
    attempts.set(key, attempt);
    const user = await verifyLogin(store, request.body);
    const token = await store.database.transaction(async (session) => {
      const token = await issueSession(store, user, ttl, session);
      await appendAudit(
        store,
        { ...context, actor: user },
        { result: "success" },
        session,
      );
      return token;
    });
    response.set("Set-Cookie", cookieValue(ttl, secure, token));
    reply(response, publicUser(user));
  });

  router.get("/auth/session", async (request, response) => {
    const actor = await authenticate(request, response, true);
    reply(response, demo ? { ...actor.profile, demo: true } : actor.profile);
  });

  if (demo) {
    router.get("/demo/reference/:section", async (request, response) => {
      const actor = await authenticate(request, response);
      if (
        actor.profile.roleId !== "superadmin" ||
        !actor.profile.organizationWide
      )
        throw new ApiError(403, "FORBIDDEN", "دسترسی به داده مرجع مجاز نیست.");
      const archive = store.database.db?.collection("reval_reference_snapshot");
      if (!archive) throw new Error("Reference database is unavailable.");
      response.set("Cache-Control", "private, no-store");
      const section = request.params.section;
      if (section === "summary") {
        const summary = await archive.findOne(
          { $expr: { $eq: ["$_id", "_summary"] } },
          { projection: { _id: 0 } },
        );
        return reply(response, summary);
      }
      if (typeof section !== "string" || !/^[a-z][a-zA-Z]*$/.test(section))
        throw new ApiError(404, "NOT_FOUND", "بخش مرجع پیدا نشد.");
      const { skip, size } = pageInput(request.query);
      const record = await archive.findOne(
        { $expr: { $eq: ["$_id", section] } },
        { projection: { _id: 0, count: 1, rows: { $slice: [skip, size] } } },
      );
      if (!record) throw new ApiError(404, "NOT_FOUND", "بخش مرجع پیدا نشد.");
      reply(response, record);
    });

    router.get("/demo/accounts", async (_request, response) => {
      const [users, roles] = await Promise.all([
        store.users
          .find(
            { demoAccount: true, active: true },
            {
              projection: { _id: 0, username: 1, name: 1, roleId: 1 },
            },
          )
          .sort({ username: 1 })
          .toArray(),
        store.roles.find().toArray(),
      ]);
      const roleNames = new Map(roles.map((role) => [role._id, role.name]));
      response.set("Cache-Control", "no-store");
      reply(
        response,
        users.flatMap(({ username, name, roleId }) => {
          const roleName = roleNames.get(roleId);
          return roleName ? [{ username, name, roleName }] : [];
        }),
      );
    });

    router.get("/demo/roles", async (request, response) => {
      await authenticate(request, response);
      const roles = await store.roles
        .find()
        .sort({ name: 1, _id: 1 })
        .toArray();
      response.set("Cache-Control", "private, no-store");
      reply(
        response,
        roles.map((role) => ({
          id: role._id,
          name: role.name,
          pages: Object.entries(modules)
            .filter(([key]) => role.permissions.includes(key + ":view"))
            .map(([, label]) => label),
        })),
      );
    });
  }

  router.post("/auth/logout", async (request, response) => {
    event(response, "auth", "logout");
    const actor = await authenticate(request, response, true);
    const context = event(response, "auth", "logout");
    await store.database.transaction(async (session) => {
      await store.sessions.deleteOne({ _id: actor.session._id }, { session });
      await appendAudit(store, context, { result: "success" }, session);
    });
    response.set("Set-Cookie", cookieValue(0, secure));
    response.status(204).end();
  });

  router.post("/auth/password", async (request, response) => {
    event(response, "auth", "password.change");
    const actor = await authenticate(request, response, true);
    const context = event(response, "auth", "password.change");
    const passwordHash = await validatePasswordChange(actor.user, request.body);
    const token = await store.database.transaction(async (session) => {
      const user = await store.users.findOneAndUpdate(
        {
          _id: actor.user._id,
          version: actor.user.version,
          active: true,
        },
        {
          $set: { passwordHash, mustChangePassword: false },
          $inc: { version: 1 },
        },
        { returnDocument: "after", session },
      );
      if (!user) throw conflict();
      await store.sessions.deleteMany({ userId: user._id }, { session });
      await appendAudit(
        store,
        context,
        { result: "success", entityId: String(user._id) },
        session,
      );
      return issueSession(store, user, ttl, session);
    });
    response.set("Set-Cookie", cookieValue(ttl, secure, token));
    response.status(204).end();
  });

  router.get("/users/line-filters", async (request, response) => {
    const actor = await authenticate(request, response);
    requirePermission(actor.grant, "users:view");
    const [catalog, [counts]] = await Promise.all([
      catalogStore(store.database)
        .records.find(
          { kind: { $in: ["lines", "branches"] } },
          { projection: { kind: 1, name: 1, code: 1, parentId: 1 } },
        )
        .sort({ code: 1, _id: 1 })
        .toArray(),
      /** @type {Promise<{ all: { count: number }[], byLine: { _id: string | null, count: number }[] }[]>} */ (
        store.users
          .aggregate([
            {
              $project: {
                lines: { $setUnion: [{ $ifNull: ["$scopes.lineId", []] }, []] },
              },
            },
            {
              $facet: {
                all: [{ $count: "count" }],
                byLine: [
                  {
                    $unwind: {
                      path: "$lines",
                      preserveNullAndEmptyArrays: true,
                    },
                  },
                  { $group: { _id: "$lines", count: { $sum: 1 } } },
                ],
              },
            },
          ])
          .toArray()
      ),
    ]);
    const branches = new Map(
      catalog
        .filter((entry) => entry.kind === "branches")
        .map((entry) => [String(entry._id), entry.code]),
    );
    const byLine = new Map(
      counts.byLine.map((entry) => [entry._id, entry.count]),
    );
    reply(response, {
      all: counts.all[0]?.count ?? 0,
      shared: byLine.get(null) ?? 0,
      lines: catalog
        .filter((entry) => entry.kind === "lines")
        .map((line) => ({
          id: String(line._id),
          name: line.name,
          code: line.code,
          branchCode: branches.get(line.parentId ?? "") ?? "",
          count: byLine.get(String(line._id)) ?? 0,
        })),
    });
  });

  /** @param {Request} request @param {Response} response */
  async function listUsers(request, response) {
    const exporting = request.path === "/users/export";
    event(response, "users", exporting ? "users.export" : "users.list");
    const actor = await authenticate(request, response);
    requirePermission(actor.grant, "users:view");
    if (exporting) requirePermission(actor.grant, "users:pdf");
    const { skip, size } = pageInput(request.query);
    const query = searchInput(request.query.q);
    const filter = query ? { $or: [{ username: query }, { name: query }] } : {};
    const line = request.query.line;
    if (line !== undefined) {
      Object.assign(filter, {
        "scopes.lineId":
          line === "shared" ? { $exists: false } : objectId(line).toHexString(),
      });
    }
    const [users, count] = await Promise.all([
      store.users
        .find(filter)
        .sort({ _id: 1 })
        .skip(skip)
        .limit(size)
        .toArray(),
      store.users.countDocuments(filter),
    ]);
    if (exporting) {
      await appendAudit(store, event(response, "users", "users.export"), {
        result: "success",
      });
    }
    reply(response, { data: users.map(publicUser), count });
  }
  router.get(["/users", "/users/export"], listUsers);

  router.get("/users/:id", async (request, response) => {
    event(response, "users", "user.view");
    const actor = await authenticate(request, response);
    const user = await store.users.findOne({
      _id: objectId(request.params.id),
    });
    const allowed =
      user &&
      (hasPermission(actor.grant, "users:view") ||
        (!user.organizationWide &&
          user.scopes.length &&
          user.scopes.every((scope) =>
            hasPermission(actor.grant, "users:view", scope),
          )));
    if (!allowed || !user) throw notFound();
    reply(response, publicUser(user));
  });

  router.post("/users", async (request, response) => {
    event(response, "users", "user.create");
    const actor = await authenticate(request, response);
    requirePermission(actor.grant, "users:users");
    const context = event(response, "users", "user.create");
    const user = await store.database.transaction(async (session) => {
      const after = await createUser(store, actor, request.body, session);
      await appendAudit(
        store,
        context,
        { result: "success", entityId: after.id, after },
        session,
      );
      return after;
    });
    reply(response, user, 201);
  });

  router.patch("/users/:id", async (request, response) => {
    const action =
      typeof request.body?.active === "boolean" ? "user.status" : "user.update";
    event(response, "users", action);
    const actor = await authenticate(request, response);
    requirePermission(actor.grant, "users:users");
    const id = objectId(request.params.id);
    const context = event(response, "users", action);
    const user = await store.database.transaction(async (session) => {
      const { before, after } = await updateUser(
        store,
        actor,
        id,
        request.body,
        session,
      );
      await appendAudit(
        store,
        context,
        { result: "success", entityId: after.id, before, after },
        session,
      );
      return after;
    });
    reply(response, user);
  });

  router.get("/roles", async (request, response) => {
    const actor = await authenticate(request, response);
    requirePermission(actor.grant, "users:view");
    reply(response, {
      roles: await store.roles.find().sort({ _id: 1 }).toArray(),
      modules,
      actions,
    });
  });

  /** @param {Actor} actor */
  function requireRoleAdministrator(actor) {
    requirePermission(actor.grant, "users:users");
    if (actor.role._id !== "superadmin")
      throw new ApiError(
        403,
        "FORBIDDEN",
        "تغییر نقش‌ها در اختیار سوپر ادمین است.",
      );
  }

  router.post("/roles", async (request, response) => {
    event(response, "users", "role.create");
    const actor = await authenticate(request, response);
    requireRoleAdministrator(actor);
    const body = fields(request.body);
    const role = {
      _id: randomUUID(),
      name: text(body.name),
      permissions: permissionInput(body.permissions),
      builtIn: false,
    };
    const context = event(response, "users", "role.create");
    await store.database.transaction(async (session) => {
      await store.roles.insertOne(role, { session });
      await appendAudit(
        store,
        context,
        { result: "success", entityId: role._id, after: role },
        session,
      );
    });
    reply(response, role, 201);
  });

  router.patch("/roles/:id", async (request, response) => {
    event(response, "users", "role.update");
    const actor = await authenticate(request, response);
    requireRoleAdministrator(actor);
    if (request.params.id === "superadmin")
      throw new ApiError(403, "FORBIDDEN", "نقش سوپر ادمین ثابت است.");
    const body = fields(request.body);
    const permissions = permissionInput(body.permissions);
    const expectedPermissions = permissionInput(body.previousPermissions);
    const context = event(response, "users", "role.update");
    const role = await store.database.transaction(async (session) => {
      const before = await store.roles.findOne(
        { _id: request.params.id },
        { session },
      );
      if (!before) throw notFound();
      if (
        JSON.stringify(before.permissions) !==
        JSON.stringify(expectedPermissions)
      )
        throw conflict();
      const after = { ...before, permissions };
      await store.roles.updateOne(
        { _id: before._id },
        { $set: { permissions } },
        { session },
      );
      await appendAudit(
        store,
        context,
        { result: "success", entityId: before._id, before, after },
        session,
      );
      return after;
    });
    reply(response, role);
  });

  /** @param {Request} request @param {Response} response */
  async function listAudit(request, response) {
    const exporting = request.path === "/audit/export";
    const context = event(
      response,
      "audit",
      exporting ? "audit.export" : "audit.list",
    );
    const actor = await authenticate(request, response);
    requirePermission(actor.grant, "audit:view");
    if (exporting) requirePermission(actor.grant, "audit:pdf");
    const { skip, size } = pageInput(request.query);
    /** @type {import("mongodb").Filter<Audit>} */
    const filter = {};
    if (request.query.result !== undefined && request.query.result !== "") {
      if (
        request.query.result !== "success" &&
        request.query.result !== "rejected"
      )
        throw badInput();
      filter.result = request.query.result;
    }
    if (request.query.module !== undefined && request.query.module !== "") {
      const module = text(request.query.module);
      if (module !== "auth" && !Object.hasOwn(modules, module))
        throw badInput();
      filter.module = module;
    }
    const query = searchInput(request.query.q);
    if (query)
      filter.$or = [
        { action: query },
        { entityId: query },
        { actorName: query },
      ];
    const [data, count] = await Promise.all([
      store.audit
        .find(filter)
        .sort({ at: -1, _id: -1 })
        .skip(skip)
        .limit(size)
        .toArray(),
      store.audit.countDocuments(filter),
    ]);
    if (exporting)
      await appendAudit(
        store,
        { ...context, actor: actor.user },
        { result: "success" },
      );
    reply(response, { data, count });
  }
  router.get(["/audit", "/audit/export"], listAudit);
  router.use("/master", catalogRouter(store, authenticate, event));
  router.use("/shipments", shipmentsRouter(store, authenticate, event));
  router.use("/inventory", inventoryRouter(store, authenticate, event));
  router.use("/handover", handoverRouter(store, authenticate, event));
  router.use("/imei", imeiRouter(store, authenticate, event, demo));
  router.use("/basket", basketRouter(store, authenticate, event, demo));
  router.use("/assembly", assemblyRouter(store, authenticate, event));
  router.use("/defects", defectsRouter(store, authenticate, event));
  router.use("/final-qc", qualityRouter(store, authenticate, event));
  router.use("/finished", finishedRouter(store, authenticate, event));
  router.use("/", insightsRouter(store, authenticate));

  /** @type {import("express").ErrorRequestHandler} */
  const reject = async (error, _request, response, next) => {
    const failure = identityError(error);
    if (
      failure instanceof ApiError &&
      response.locals.auditAction &&
      failure.status !== 429
    ) {
      try {
        await appendAudit(
          store,
          {
            ...response.locals.auditAction,
            actor: response.locals.actor?.user ?? null,
            correlationId: String(response.locals.correlationId),
          },
          { result: "rejected", reason: failure.code },
        );
      } catch (auditFailure) {
        next(auditFailure);
        return;
      }
    }
    next(failure);
  };
  router.use(reject);
  return router;
}
