import { ObjectId, MongoServerError } from "mongodb";
import { catalogStore } from "../catalog/store.js";
import { validateScopeReferences } from "../catalog/records.js";
import { ApiError } from "../http-error.js";
import { hashPassword } from "./password.js";
import { hasPermission } from "./permissions.js";
import { publicUser } from "./store.js";
import {
  accessInput,
  badInput,
  fields,
  normalizeUsername,
  text,
  validPassword,
  versionInput,
} from "./validation.js";

/** @typedef {ReturnType<typeof import("./store.js").identityStore>} Store */
/** @typedef {import("./store.js").User} User */
/** @typedef {import("./store.js").Role} Role */
/** @typedef {Awaited<ReturnType<typeof import("./sessions.js").identify>>} Actor */
export const notFound = () => new ApiError(404, "NOT_FOUND", "رکورد پیدا نشد.");
export const conflict = () =>
  new ApiError(409, "CONFLICT", "رکورد تغییر کرده یا مقدار تکراری است.");
const forbidden = () =>
  new ApiError(403, "FORBIDDEN", "دسترسی به این عملیات مجاز نیست.");

/** @param {unknown} error */
export function identityError(error) {
  return error instanceof MongoServerError && error.code === 11000
    ? conflict()
    : error;
}

/** @param {Store} store @param {string} roleId @param {import("mongodb").ClientSession} session */
async function findRole(store, roleId, session) {
  const role = await store.roles.findOne({ _id: roleId }, { session });
  if (!role) throw notFound();
  return role;
}

/** @param {Actor} actor @param {Role} role */
function canManageRole(actor, role) {
  if (
    role._id === "superadmin" ||
    (actor.role._id !== "superadmin" &&
      role.permissions.includes("users:users"))
  )
    throw forbidden();
}

/** @param {Actor} actor @param {boolean} wide @param {import("./permissions.js").Scope[]} scopes */
function canManageScopes(actor, wide, scopes) {
  if (actor.grant.organizationWide) return;
  if (
    wide ||
    !scopes.every((scope) => hasPermission(actor.grant, "users:users", scope))
  )
    throw forbidden();
}

/** @param {Store} store @param {Actor} actor @param {unknown} value @param {import("mongodb").ClientSession} session */
export async function createUser(store, actor, value, session) {
  const body = fields(value);
  const role = await findRole(store, text(body.roleId), session);
  canManageRole(actor, role);
  const access = accessInput(body);
  canManageScopes(actor, access.organizationWide, access.scopes);
  await validateScopeReferences(
    catalogStore(store.database),
    access.scopes,
    session,
  );
  if (!validPassword(body.password) || typeof body.password !== "string")
    throw badInput();

  const user = {
    _id: new ObjectId(),
    username: normalizeUsername(body.username),
    name: text(body.name),
    unit: text(body.unit, 100, true),
    roleId: role._id,
    ...access,
    active: true,
    mustChangePassword: true,
    passwordHash: await hashPassword(body.password),
    version: 0,
  };
  await store.users.insertOne(user, { session });
  return publicUser(user);
}

/** @param {Store} store @param {Actor} actor @param {ObjectId} id @param {unknown} value @param {import("mongodb").ClientSession} session */
export async function updateUser(store, actor, id, value, session) {
  const body = fields(value);
  const previous = await store.users.findOne({ _id: id }, { session });
  if (!previous) throw notFound();
  if (previous._id.equals(actor.user._id) || previous.roleId === "superadmin")
    throw forbidden();
  const version = versionInput(body.version);
  if (previous.version !== version) throw conflict();
  const oldRole = await findRole(store, previous.roleId, session);
  canManageRole(actor, oldRole);
  canManageScopes(actor, previous.organizationWide, previous.scopes);
  /** @type {Partial<User>} */
  let update;
  if (typeof body.active === "boolean") {
    update = { active: body.active };
  } else {
    const role = await findRole(store, text(body.roleId), session);
    canManageRole(actor, role);
    const access = accessInput(body);
    canManageScopes(actor, access.organizationWide, access.scopes);
    await validateScopeReferences(
      catalogStore(store.database),
      access.scopes,
      session,
    );
    update = {
      name: text(body.name),
      unit: text(body.unit, 100, true),
      roleId: role._id,
      ...access,
    };
  }
  const result = await store.users.findOneAndUpdate(
    { _id: id, version },
    {
      $set: update,
      $inc: { version: 1 },
    },
    { session, returnDocument: "after" },
  );
  if (!result) throw conflict();
  await store.sessions.deleteMany({ userId: id }, { session });
  return { before: publicUser(previous), after: publicUser(result) };
}
