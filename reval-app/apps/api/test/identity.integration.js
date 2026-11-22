import { assertContractResponse } from "./support/release-contract.js";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { catalogStore, initializeCatalog } from "../src/catalog/store.js";
import { readConfig, readIdentityOptions } from "../src/config.js";
import {
  connectDatabase,
  isDatabaseReady,
} from "../src/database/connection.js";
import { hasPermission } from "../src/identity/permissions.js";
import { identityRouter } from "../src/identity/routes.js";
import { identityStore, initializeIdentity } from "../src/identity/store.js";

test("identity, password rotation, scoped access, audit and session lifecycle", async () => {
  const source = readConfig({
    NODE_ENV: "test",
    MONGODB_URI: process.env.TEST_MONGODB_URI,
  });
  const namespace = "reval_test_" + randomBytes(8).toString("hex");
  const uri = source.uri.replace(
    /\/reval_test(?:_[a-z0-9]+)?(?=\?)/,
    "/" + namespace,
  );
  assert.notEqual(uri, source.uri);
  const database = await connectDatabase(uri);
  const store = identityStore(database);
  const origin = "http://127.0.0.1:5173";
  const initial = randomBytes(20).toString("hex");
  const updated = randomBytes(20).toString("hex");
  const app = createApp({
    isReady: () => isDatabaseReady(database),
    identity: identityRouter(
      store,
      readIdentityOptions({
        NODE_ENV: "test",
        APP_ORIGIN: origin,
        SESSION_TTL_SECONDS: "3600",
      }),
    ),
  });
  const server = app.listen(0, "127.0.0.1");
  const demoServer = createApp({
    isReady: () => isDatabaseReady(database),
    identity: identityRouter(store, { origin, ttl: 3600, demo: true }),
  }).listen(0, "127.0.0.1");
  try {
    await Promise.all([
      once(server, "listening"),
      once(demoServer, "listening"),
    ]);
    await assert.rejects(
      initializeIdentity(store, {}),
      /First startup requires/,
    );
    await initializeIdentity(store, {
      REVAL_ADMIN_USERNAME: "bootstrap",
      REVAL_ADMIN_PASSWORD: initial,
    });
    assert.equal(await store.roles.countDocuments(), 20);
    async function call(
      path,
      {
        method = "GET",
        body,
        cookie,
        sourceOrigin = origin,
        demo = false,
      } = {},
    ) {
      const port = (demo ? demoServer : server).address().port;
      const base = "http://127.0.0.1:" + port + "/api/v1";
      const response = await fetch(base + path, {
        method,
        headers: {
          Origin: sourceOrigin,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = response.status === 204 ? null : await response.json();
      assertContractResponse(method, path, response.status, payload);
      if (payload) {
        const serialized = JSON.stringify(payload);
        assert.doesNotMatch(
          serialized,
          /passwordHash|currentPassword|newPassword|reval_session=/,
        );
        assert.ok(
          !serialized.includes(initial) && !serialized.includes(updated),
        );
      }
      return {
        status: response.status,
        data: payload?.result,
        error: payload,
        cookie: response.headers.get("set-cookie"),
      };
    }
    const cookiePart = (result) => result.cookie?.split(";")[0];
    const post = (path, body, cookie) =>
      call(path, { method: "POST", body, cookie });
    const signIn = (username, password) =>
      post("/auth/login", { username, password });
    const rotate = (cookie, first, second) =>
      post(
        "/auth/password",
        { currentPassword: first, newPassword: second },
        cookie,
      );

    assert.equal((await call("/users")).status, 401);
    assert.equal((await call("/users/line-filters")).status, 401);
    assert.equal(
      (
        await call("/auth/login", {
          method: "POST",
          body: { username: "bootstrap", password: initial },
          sourceOrigin: "https://example.test",
        })
      ).status,
      403,
    );
    assert.equal((await signIn("bootstrap", "invalid password")).status, 401);
    const aliasLogin = await call("/auth/login", {
      method: "POST",
      body: { username: "bootstrap", password: initial },
      sourceOrigin: "http://localhost:5173",
    });
    assert.equal(aliasLogin.status, 200);
    assert.equal(
      (
        await call("/auth/login", {
          method: "POST",
          body: { username: "bootstrap", password: initial },
          sourceOrigin: "http://localhost:5174",
        })
      ).error.code,
      "INVALID_ORIGIN",
    );
    const adminLogin = await signIn("bootstrap", initial);
    assert.match(adminLogin.cookie, /HttpOnly; SameSite=Lax; Max-Age=3600/);
    const oldToken = cookiePart(adminLogin);
    assert.equal(
      (await call("/users", { cookie: oldToken })).error.code,
      "PASSWORD_CHANGE_REQUIRED",
    );
    const change = await rotate(oldToken, initial, updated);
    assert.equal(change.status, 204);
    const admin = cookiePart(change);
    assert.equal(
      (await call("/auth/session", { cookie: oldToken })).status,
      401,
    );
    assert.equal((await call("/users", { cookie: admin })).status, 200);
    assert.equal((await call("/demo/roles", { cookie: admin })).status, 404);
    assert.equal((await call("/demo/roles", { demo: true })).status, 401);
    assert.equal(
      (await call("/auth/session", { cookie: admin })).data.demo,
      undefined,
    );
    assert.equal(
      (await call("/auth/session", { demo: true, cookie: admin })).data.demo,
      true,
    );
    await initializeIdentity(store, {
      REVAL_ADMIN_USERNAME: "bootstrap",
      REVAL_ADMIN_PASSWORD: initial,
    });
    assert.equal((await signIn("bootstrap", initial)).status, 401);
    assert.equal((await signIn("bootstrap", updated)).status, 200);

    const role = await post(
      "/roles",
      { name: "بازبین", permissions: ["users:view", "audit:view"] },
      admin,
    );
    assert.equal(role.status, 201);
    const roleId = role.data._id;
    const updatedRole = await call("/roles/" + roleId, {
      method: "PATCH",
      cookie: admin,
      body: {
        previousPermissions: role.data.permissions,
        permissions: ["users:view", "audit:view", "dashboard:view"],
      },
    });
    assert.equal(updatedRole.status, 200);
    assert.ok(updatedRole.data.permissions.includes("dashboard:view"));
    assert.equal(
      (
        await call("/roles/superadmin", {
          method: "PATCH",
          cookie: admin,
          body: { previousPermissions: [], permissions: [] },
        })
      ).status,
      403,
    );
    await initializeCatalog(catalogStore(database));
    const branch = await post(
      "/master/branches",
      { code: "BR-TEST", name: "Branch" },
      admin,
    );
    assert.equal(branch.status, 201);
    const firstLine = await post(
      "/master/lines",
      { code: "L-1", name: "Line 1", parentId: branch.data.id },
      admin,
    );
    const secondLine = await post(
      "/master/lines",
      { code: "L-2", name: "Line 2", parentId: branch.data.id },
      admin,
    );
    assert.equal(firstLine.status, 201);
    assert.equal(secondLine.status, 201);
    const line1 = firstLine.data.id;
    const line2 = secondLine.data.id;
    const one = { lineId: line1, stationId: "000000000000000000000011" };
    assert.equal(
      hasPermission(
        {
          permissions: ["assembly:scan"],
          organizationWide: false,
          scopes: [one],
        },
        "assembly:scan",
        { ...one, lineId: line2 },
      ),
      false,
    );
    assert.equal(
      hasPermission(
        {
          permissions: ["assembly:scan"],
          organizationWide: false,
          scopes: [one],
        },
        "assembly:scan",
        one,
      ),
      true,
    );
    const temporary = randomBytes(20).toString("hex");
    const setPassword = randomBytes(20).toString("hex");
    async function add(username, ...scopes) {
      return post(
        "/users",
        {
          name: username,
          username,
          roleId,
          password: temporary,
          organizationWide: !scopes.length,
          scopes,
        },
        admin,
      );
    }
    const user = await add("scoped-user", { lineId: line1 });
    const other = await add("other-line", { lineId: line2 });
    const broad = await add("broad-user");
    const shared = await add("branch-user", { branchId: branch.data.id });
    const multiple = await add(
      "multi-line",
      { lineId: line1 },
      { branchId: branch.data.id, lineId: line1 },
      { lineId: line2 },
    );
    assert.equal(user.status, 201);
    assert.equal(other.status, 201);
    assert.equal(shared.status, 201);
    assert.equal(multiple.status, 201);
    const filters = await call("/users/line-filters", { cookie: admin });
    assert.equal(filters.status, 200);
    assert.deepEqual(filters.data, {
      all: 6,
      shared: 3,
      lines: [
        {
          id: line1,
          name: "Line 1",
          code: "L-1",
          branchCode: "BR-TEST",
          count: 2,
        },
        {
          id: line2,
          name: "Line 2",
          code: "L-2",
          branchCode: "BR-TEST",
          count: 2,
        },
      ],
    });
    const sharedUsers = await call("/users?line=shared", { cookie: admin });
    assert.deepEqual(
      new Set(sharedUsers.data.data.map((row) => row.username)),
      new Set(["bootstrap", "broad-user", "branch-user"]),
    );
    const linePage = await call("/users?line=" + line1 + "&size=1&page=1", {
      cookie: admin,
    });
    assert.equal(linePage.status, 200);
    assert.equal(linePage.data.count, 2);
    assert.deepEqual(
      linePage.data.data.map((row) => row.id),
      [multiple.data.id],
    );
    const queryFilter = "?line=" + line2 + "&q=multi";
    const matching = await call("/users" + queryFilter, { cookie: admin });
    assert.equal(matching.data.count, 1);
    assert.equal(matching.data.data[0].id, multiple.data.id);
    assert.deepEqual(
      (await call("/users/export" + queryFilter, { cookie: admin })).data,
      matching.data,
    );
    assert.equal(
      (await call("/users?line=invalid", { cookie: admin })).status,
      400,
    );
    assert.equal((await add("scoped-user", { lineId: line1 })).status, 409);
    const scoped = cookiePart(
      await rotate(
        cookiePart(await signIn("scoped-user", temporary)),
        temporary,
        setPassword,
      ),
    );
    assert.equal(
      (await call("/users/" + user.data.id, { cookie: scoped })).status,
      200,
    );
    assert.equal(
      (await call("/users/" + other.data.id, { cookie: scoped })).status,
      404,
    );
    assert.equal((await call("/users", { cookie: scoped })).status, 403);
    const preview = await call("/demo/roles", { demo: true, cookie: scoped });
    assert.equal(preview.status, 200);
    assert.ok(
      preview.data.some(
        (item) => item.id === "superadmin" && item.pages.length,
      ),
    );
    assert.equal(
      (
        await call("/demo/roles", {
          demo: true,
          cookie: scoped,
          method: "POST",
          body: { roleId: "superadmin" },
        })
      ).status,
      404,
    );
    assert.equal(
      (await call("/users", { demo: true, cookie: scoped })).status,
      403,
    );
    assert.equal(
      (await call("/auth/session", { demo: true, cookie: scoped })).data.roleId,
      roleId,
    );
    assert.equal(
      (await call("/users/line-filters", { cookie: scoped })).status,
      403,
    );
    const reader = cookiePart(
      await rotate(
        cookiePart(await signIn("broad-user", temporary)),
        temporary,
        setPassword,
      ),
    );
    assert.equal((await call("/audit", { cookie: reader })).status, 200);
    assert.equal((await call("/audit/export", { cookie: reader })).status, 403);
    assert.equal((await call("/users/export", { cookie: reader })).status, 403);
    assert.equal(
      (await post("/roles", { name: "ممنوع", permissions: [] }, reader)).status,
      403,
    );

    const profile = await call("/auth/session", { cookie: reader });
    assert.equal(profile.data.id, broad.data.id);
    const renamed = await call("/users/" + broad.data.id, {
      method: "PATCH",
      cookie: admin,
      body: {
        version: profile.data.version,
        name: "کاربر بازبین",
        unit: "ممیزی",
        roleId,
        organizationWide: true,
        scopes: [],
      },
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.data.name, "کاربر بازبین");
    const nextReader = cookiePart(await signIn("broad-user", setPassword));
    const patch = await call("/users/" + broad.data.id, {
      method: "PATCH",
      cookie: admin,
      body: { active: false, version: renamed.data.version },
    });
    assert.equal(patch.status, 200);
    assert.equal(
      (await call("/auth/session", { cookie: nextReader })).status,
      401,
    );
    assert.equal((await signIn("broad-user", setPassword)).status, 401);

    const tokenHash = createHash("sha256")
      .update(scoped.split("=")[1])
      .digest("hex");
    await store.sessions.updateOne(
      { _id: tokenHash },
      { $set: { expiresAt: new Date(0) } },
    );
    assert.equal((await call("/auth/session", { cookie: scoped })).status, 401);
    const audit = await call("/audit?size=100", { cookie: admin });
    assert.ok(
      audit.data.data.some(
        (record) =>
          record.action === "user.status" &&
          record.actorId &&
          record.before.active &&
          !record.after.active &&
          record.correlationId,
      ),
    );
    assert.ok(
      audit.data.data.some(
        (record) =>
          record.result === "rejected" && record.action === "user.view",
      ),
    );
    assert.ok(
      !JSON.stringify(audit.data).includes(temporary) &&
        !JSON.stringify(audit.data).includes(setPassword),
    );
    assert.equal((await post("/auth/logout", undefined, admin)).status, 204);
    assert.equal((await call("/auth/session", { cookie: admin })).status, 401);
  } finally {
    await Promise.all(
      [server, demoServer].map(
        (listener) => new Promise((resolve) => listener.close(resolve)),
      ),
    );
    try {
      assert.equal(database.name, namespace);
      await database.dropDatabase();
    } finally {
      await database.close();
    }
  }
});
