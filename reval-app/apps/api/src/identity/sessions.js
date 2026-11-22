import { createHash, randomBytes } from "node:crypto";
import { ApiError } from "../http-error.js";
import { hashPassword, verifyPassword } from "./password.js";
import {
  badInput,
  fields,
  normalizeUsername,
  passwordInput,
  validPassword,
} from "./validation.js";
import { publicUser } from "./store.js";

/** @typedef {ReturnType<typeof import("./store.js").identityStore>} Store */
/** @typedef {import("./store.js").User} User */
export const cookieName = "reval_session";
const unauthenticated = () =>
  new ApiError(401, "UNAUTHENTICATED", "نام کاربری، رمز یا نشست معتبر نیست.");

/** @param {string} token */
const digest = (token) => createHash("sha256").update(token).digest("hex");

/** @param {string | undefined} cookie */
export function sessionToken(cookie) {
  return cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(cookieName + "="))
    ?.slice(cookieName.length + 1);
}

/** @param {Store} store @param {string | undefined} token */
export async function identify(store, token) {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw unauthenticated();
  const session = await store.sessions.findOne({
    _id: digest(token),
    expiresAt: { $gt: new Date() },
  });
  if (!session) throw unauthenticated();
  const user = await store.users.findOne({
    _id: session.userId,
    active: true,
    version: session.version,
  });
  if (!user) throw unauthenticated();
  const role = await store.roles.findOne({ _id: user.roleId });
  if (!role) throw unauthenticated();
  return {
    user,
    session,
    role,
    grant: {
      permissions: role.permissions,
      organizationWide: user.organizationWide,
      scopes: user.scopes,
    },
    profile: {
      ...publicUser(user),
      roleName: role.name,
      permissions: role.permissions,
    },
  };
}

/** @param {Store} store @param {unknown} value */
export async function verifyLogin(store, value) {
  const body = fields(value);
  const username = normalizeUsername(body.username);
  const password = passwordInput(body.password);
  const user = await store.users.findOne({ username });
  const matched = await verifyPassword(password, user?.passwordHash);
  if (!user || !matched || !user.active) throw unauthenticated();
  return user;
}

/** @param {Store} store @param {User} user @param {number} ttl @param {import("mongodb").ClientSession} transaction */
export async function issueSession(store, user, ttl, transaction) {
  const token = randomBytes(32).toString("hex");
  await store.sessions.insertOne(
    {
      _id: digest(token),
      userId: user._id,
      version: user.version,
      expiresAt: new Date(Date.now() + ttl * 1000),
    },
    { session: transaction },
  );
  return token;
}

/** @param {User} user @param {unknown} value */
export async function validatePasswordChange(user, value) {
  const body = fields(value);
  const current = passwordInput(body.currentPassword);
  if (
    !validPassword(body.newPassword) ||
    typeof body.newPassword !== "string" ||
    current === body.newPassword
  )
    throw badInput();
  if (!(await verifyPassword(current, user.passwordHash))) {
    throw new ApiError(400, "INVALID_PASSWORD", "رمز فعلی معتبر نیست.");
  }
  return hashPassword(body.newPassword);
}

/** @param {number} ttl @param {boolean} secure @param {string} [token] */
export function cookieValue(ttl, secure, token = "") {
  return `${cookieName}=${token}; Path=/api/v1; HttpOnly; SameSite=Lax; Max-Age=${ttl}${secure ? "; Secure" : ""}`;
}
