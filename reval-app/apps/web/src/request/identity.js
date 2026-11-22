/** @typedef {{ id: string, username: string, name: string, unit: string, roleId: string, organizationWide: boolean, scopes: Record<string, string>[], active: boolean, mustChangePassword: boolean, version: number }} User */
/** @typedef {User & {roleName: string, permissions: string[], demo?: boolean}} Profile */
/** @typedef {{ _id: string, name: string, builtIn: boolean, permissions: string[] }} Role */
/** @typedef {{roles: Role[], modules: Record<string, string>, actions: Record<string, string>}} Catalogue */
/** @typedef {{_id: string, actorName?: string, module: string, action: string, entityId?: string, before?: object, after?: object, result: string, reason?: string, at: string}} Audit */
export class RequestError extends Error {
  /** @param {number} status @param {string} message @param {ErrorOptions} [options] */
  constructor(status, message, options) {
    super(message, options);
    this.status = status;
  }
}

/**
 * @template T
 * @param {string} path
 * @param {{ method?: string, body?: object, signal?: AbortSignal, headers?: Record<string,string> }} [options]
 * @returns {Promise<T>}
 */
export async function request(
  path,
  { method = "GET", body, signal, headers = {} } = {},
) {
  const binary = body instanceof Blob;
  const response = await fetch("/api/v1" + path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: {
      ...(body
        ? {
            "Content-Type": binary
              ? body.type || "application/octet-stream"
              : "application/json",
          }
        : {}),
      ...headers,
    },
    ...(body
      ? {
          body: binary ? body : JSON.stringify(body),
        }
      : {}),
  });
  if (response.status === 204) return /** @type {T} */ (undefined);
  const payload = await response.json().catch(() => null);
  if (
    response.status === 401 &&
    path !== "/auth/session" &&
    path !== "/auth/login"
  ) {
    window.dispatchEvent(new Event("reval:session-expired"));
  }
  if (!response.ok || !payload) {
    throw new RequestError(
      response.status,
      payload?.message || "ارتباط با سرور برقرار نشد.",
    );
  }
  return payload.result;
}

/** @param {unknown} error */
export const errorMessage = (error) =>
  error instanceof RequestError ? error.message : "ارتباط با سرور برقرار نشد.";
