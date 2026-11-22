import { ObjectId } from "mongodb";
import defaultRoles from "./default-roles.json" with { type: "json" };
import { hashPassword } from "./password.js";
import { validPassword, normalizeUsername } from "./validation.js";

/** @typedef {{ _id: string, name: string, permissions: string[], builtIn: boolean }} Role */
/** @typedef {{ _id: ObjectId, username: string, name: string, unit: string, roleId: string, organizationWide: boolean, scopes: import("./permissions.js").Scope[], active: boolean, mustChangePassword: boolean, passwordHash: string, version: number, demoAccount?: true }} User */
/** @typedef {{ _id: string, userId: ObjectId, version: number, expiresAt: Date }} Session */
/** @typedef {{ actorId: ObjectId | null, actorName: string | null, action: string, module: string, entityId?: string, before?: object, after?: object, result: "success" | "rejected", reason?: string, at: Date, correlationId: string }} Audit */

/** @param {import("mongoose").Connection} database */
export function identityStore(database) {
  if (!database.db) throw new Error("Identity database is unavailable.");
  return {
    users: /** @type {import("mongodb").Collection<User>} */ (
      database.db.collection("reval_users")
    ),
    roles: /** @type {import("mongodb").Collection<Role>} */ (
      database.db.collection("reval_roles")
    ),
    sessions: /** @type {import("mongodb").Collection<Session>} */ (
      database.db.collection("reval_sessions")
    ),
    audit: /** @type {import("mongodb").Collection<Audit>} */ (
      database.db.collection("reval_audit")
    ),
    database,
  };
}

/** @param {ReturnType<typeof identityStore>} store @param {NodeJS.ProcessEnv} env */
export async function initializeIdentity(store, env) {
  await store.users.createIndex({ username: 1 }, { unique: true });
  await store.roles.createIndex({ name: 1 }, { unique: true });
  await store.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await store.sessions.createIndex({ userId: 1 });
  await store.audit.createIndex({ at: -1, _id: -1 });
  await store.audit.createIndex({ actorId: 1, at: -1 });

  await store.roles.bulkWrite(
    defaultRoles.map((role) => ({
      updateOne: {
        filter: { _id: role._id },
        update: { $setOnInsert: role },
        upsert: true,
      },
    })),
  );
  if (
    await store.users.findOne(
      { roleId: "superadmin" },
      { projection: { _id: 1 } },
    )
  )
    return;

  const password = env.REVAL_ADMIN_PASSWORD;
  const username = env.REVAL_ADMIN_USERNAME;
  if (!username || !password || !validPassword(password)) {
    throw new Error(
      "First startup requires REVAL_ADMIN_USERNAME and REVAL_ADMIN_PASSWORD (at least 12 characters).",
    );
  }

  const admin = {
    _id: new ObjectId("000000000000000000000001"),
    username: normalizeUsername(username),
    name: "سوپر ادمین",
    unit: "",
    roleId: "superadmin",
    organizationWide: true,
    scopes: [],
    active: true,
    mustChangePassword: true,
    passwordHash: await hashPassword(password),
    version: 0,
  };
  await store.users.updateOne(
    { _id: admin._id },
    { $setOnInsert: admin },
    { upsert: true },
  );
}

/** @param {User} user */
export function publicUser(user) {
  const {
    _id,
    username,
    name,
    unit,
    roleId,
    organizationWide,
    scopes,
    active,
    mustChangePassword,
    version,
  } = user;
  return {
    id: String(_id),
    username,
    name,
    unit,
    roleId,
    organizationWide,
    scopes,
    active,
    mustChangePassword,
    version,
  };
}
