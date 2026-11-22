import { useEffect, useState } from "react";
import { loadOptions } from "./catalog.js";
import { errorMessage } from "../request/identity.js";

/** @param {string[]} kinds @param {number} [revision] @param {boolean} [activeOnly] */
export function useOptions(kinds, revision = 0, activeOnly = true) {
  const key = [...new Set(kinds)].sort().join();
  const [entries, setEntries] = useState(
    /** @type {Record<string,import("./catalog.js").Entry[]>} */ ({}),
  );
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const current = new AbortController();
    setLoading(true);
    setError("");
    const items = key ? key.split(",") : [];
    Promise.all(
      items.map(
        async (item) =>
          /** @type {const} */ ([
            item,
            await loadOptions(item, current.signal, activeOnly),
          ]),
      ),
    )
      .then((results) => {
        if (!current.signal.aborted) setEntries(Object.fromEntries(results));
      })
      .catch((error) => {
        if (!current.signal.aborted) setError(errorMessage(error));
      })
      .finally(() => {
        if (!current.signal.aborted) setLoading(false);
      });
    return () => current.abort();
  }, [key, revision, activeOnly]);
  return { entries, error, loading };
}
