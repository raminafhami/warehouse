import { useEffect, useState } from "react";
import { errorMessage, request } from "../request/identity.js";

/**
 * @template T
 * @param {string | null} path
 * @param {T} initial
 * @param {number} revision
 */
export function useResource(path, initial, revision) {
  const [result, setResult] = useState(
    /** @type {{path:string, revision:number, data:T, error:string}|null} */ (
      null
    ),
  );
  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    /** @type {Promise<T>} */
    const response = request(path, { signal: controller.signal });
    response
      .then((value) => {
        if (!controller.signal.aborted)
          setResult({ path, revision, data: value, error: "" });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setResult((previous) => ({
            path,
            revision,
            data: previous?.path === path ? previous.data : initial,
            error: errorMessage(error),
          }));
      });
    return () => controller.abort();
  }, [path, revision]);
  const current = result?.path === path && result.revision === revision;
  return {
    data: result?.path === path ? result.data : initial,
    error: current ? result.error : "",
    loading: path !== null && !current,
  };
}
