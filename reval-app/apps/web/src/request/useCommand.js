import { useRef } from "react";
import { request, RequestError } from "./identity.js";

export function useCommand() {
  const attempt = useRef(
    /** @type {{signature:string,key:string}|null} */ (null),
  );
  /** @template T @param {string} path @param {object} body @returns {Promise<T>} */
  return async (path, body) => {
    const signature = JSON.stringify([path, body]);
    const selected =
      attempt.current?.signature === signature
        ? attempt.current
        : { signature, key: crypto.randomUUID() };
    attempt.current = selected;
    try {
      /** @type {T} */
      const result = await request(path, {
        method: "POST",
        body,
        signal: AbortSignal.timeout(15_000),
        headers: { "Idempotency-Key": selected.key },
      });
      if (attempt.current === selected) attempt.current = null;
      return result;
    } catch (error) {
      if (
        error instanceof RequestError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408
      ) {
        if (attempt.current === selected) attempt.current = null;
        throw error;
      }
      throw new RequestError(
        0,
        "نتیجهٔ ثبت مشخص نیست. پس از اتصال، همین فرم را بدون تغییر دوباره ارسال کنید.",
        { cause: error },
      );
    }
  };
}
