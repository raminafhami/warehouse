import { useEffect, useState } from "react";
import { isApiReady } from "../request/api.js";
import styles from "./StatusPage.module.css";

const message = {
  pending: "در حال بررسی اتصال…",
  ready: "سرور و پایگاه داده آماده‌اند.",
  unavailable: "اتصال به سرور یا پایگاه داده برقرار نشد.",
};

export function StatusPage() {
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState(
    /** @type {keyof typeof message} */ ("pending"),
  );

  useEffect(() => {
    const controller = new AbortController();
    isApiReady(controller.signal)
      .then((ready) => {
        if (!controller.signal.aborted)
          setStatus(ready ? "ready" : "unavailable");
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus("unavailable");
      });

    return () => controller.abort();
  }, [attempt]);

  return (
    <main className={styles.layout}>
      <section className={styles.panel} aria-labelledby="reval-title">
        <h1 id="reval-title">REVAL</h1>
        <p role="status">{message[status]}</p>
        <button
          type="button"
          disabled={status === "pending"}
          onClick={() => {
            setStatus("pending");
            setAttempt((value) => value + 1);
          }}
        >
          بررسی دوباره
        </button>
      </section>
    </main>
  );
}
