import { ObjectId } from "mongodb";
import { ApiError } from "../http-error.js";
import { permissionKeys, scopeKeys } from "./permissions.js";

export const badInput = () =>
  new ApiError(400, "INVALID_INPUT", "مقادیر فرم را بررسی کنید.");

/** @param {unknown} value */
export function fields(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw badInput();
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @param {number} [max] @param {boolean} [optional] */
export function text(value, max = 100, optional = false) {
  if (optional && (value === "" || value === undefined)) return "";
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    throw badInput();
  return value.trim();
}

/** @param {unknown} value */
export function normalizeUsername(value) {
  const username = text(value, 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)) throw badInput();
  return username;
}

/** @param {unknown} value */
export function validPassword(value) {
  return typeof value === "string" && value.length >= 12 && value.length <= 256;
}

/** @param {unknown} value */
export function passwordInput(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256)
    throw badInput();
  return value;
}

/** @param {unknown} value */
export function objectId(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{24}$/i.test(value))
    throw badInput();
  return new ObjectId(value);
}

/** @param {unknown} value */
export function versionInput(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw badInput();
  return value;
}

/** @param {unknown} value */
export function accessInput(value) {
  const body = fields(value);
  if (
    typeof body.organizationWide !== "boolean" ||
    !Array.isArray(body.scopes) ||
    body.scopes.length > 50
  )
    throw badInput();
  const scopes = body.scopes.map((input) => {
    const scope = fields(input);
    const keys = Object.keys(scope);
    if (
      !keys.length ||
      keys.some((key) => !scopeKeys.some((candidate) => candidate === key))
    )
      throw badInput();
    if (scope.stationId && !scope.lineId) throw badInput();
    return Object.fromEntries(
      keys.map((key) => [key, objectId(scope[key]).toHexString()]),
    );
  });
  if (body.organizationWide === Boolean(scopes.length)) throw badInput();
  return { organizationWide: body.organizationWide, scopes };
}

/** @param {unknown} value */
export function permissionInput(value) {
  if (
    !Array.isArray(value) ||
    value.length > permissionKeys.size ||
    value.some((key) => typeof key !== "string" || !permissionKeys.has(key))
  )
    throw badInput();
  return /** @type {string[]} */ ([...new Set(value)]);
}

/** @param {import("express").Request["query"]} query */
export function pageInput(query) {
  const page = Number(query.page ?? 0);
  const size = Number(query.size ?? 12);
  if (
    !Number.isSafeInteger(page) ||
    page < 0 ||
    page > 10000 ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > 100
  )
    throw badInput();
  return { skip: page * size, size };
}
