import { useState } from "react";
import { errorMessage, request, RequestError } from "../request/identity.js";
import { useCommand } from "../request/useCommand.js";
import { hamtaLabels } from "./api.js";
import { ImeiDialog } from "./Dialog.jsx";

/** @param {{units:import("./api.js").Unit[],close:()=>void,saved:()=>void}} props */
export function HamtaEditor({ units, close, saved }) {
  const command = useCommand();
  const pending = units[0].hamtaStatus === "pending";
  const [action, setAction] = useState(pending ? "submit" : "reconcile");
  const [outcome, setOutcome] = useState(pending ? "submitted" : "activated");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** @param {import("react").FormEvent<HTMLFormElement>} event */
  async function save(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const entries = units.map((unit) => ({
        id: unit.id,
        version: unit.version,
        outcome,
        trackingCode: form.get(unit.id + "-code") ?? undefined,
        evidence: form.get(unit.id + "-evidence") ?? undefined,
        reason: form.get(unit.id + "-reason") ?? undefined,
      }));
      await command("/imei/hamta/results", { action, entries });
      saved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ImeiDialog
      title={units.length > 1 ? "ثبت گروهی نتیجهٔ همتا" : "ثبت نتیجهٔ همتا"}
      onClose={close}
      busy={busy}
    >
      <form onSubmit={save}>
        <p>نتیجه یا کد رهگیری را از سامانهٔ رسمی همتا وارد کنید.</p>
        {!pending && (
          <label>
            عملیات
            <select
              value={action}
              onChange={(event) => {
                const next = event.target.value;
                setAction(next);
                if (next === "retry") setOutcome("submitted");
              }}
            >
              <option value="reconcile">تطبیق با نتیجهٔ رسمی</option>
              <option value="retry">ثبت تلاش مجدد</option>
            </select>
          </label>
        )}
        <label>
          نتیجه
          <select
            value={outcome}
            onChange={(event) => setOutcome(event.target.value)}
          >
            <option value="submitted">ارسال‌شده، نتیجه نامعلوم</option>
            <option value="error">خطا یا پاسخ ناموفق</option>
            {action !== "retry" && (
              <option value="activated">فعال‌شده در همتا</option>
            )}
          </select>
        </label>
        {units.map((unit) => (
          <fieldset key={unit.id}>
            <legend>
              {unit.code} · <bdi>{unit.numbers.join(" / ")}</bdi>
            </legend>
            {outcome === "activated" ? (
              <>
                <label>
                  کد رهگیری واقعی
                  <input
                    name={unit.id + "-code"}
                    required
                    maxLength={100}
                    dir="ltr"
                  />
                </label>
                <label>
                  مرجع شاهد
                  <input name={unit.id + "-evidence"} maxLength={240} />
                </label>
              </>
            ) : (
              <label>
                شرح نتیجه
                <textarea name={unit.id + "-reason"} required maxLength={500} />
              </label>
            )}
          </fieldset>
        ))}
        {error && <p role="alert">{error}</p>}
        <div className="toolbar">
          <button className="primary" disabled={busy}>
            ثبت نتیجه
          </button>
          <button type="button" onClick={close} disabled={busy}>
            انصراف
          </button>
        </div>
      </form>
    </ImeiDialog>
  );
}

/** @param {{close:()=>void}} props */
export function HamtaDemo({ close }) {
  const [outcome, setOutcome] = useState("submitted");
  const [result, setResult] = useState(
    /** @type {import("./api.js").HamtaStatus|""} */ (""),
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    setError("");
    try {
      /** @type {{status:import("./api.js").HamtaStatus}} */
      const response = await request("/imei/hamta/simulate", {
        method: "POST",
        body: { outcome },
      });
      setResult(response.status);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ImeiDialog title="شبیه‌سازی — ثبت واقعی نیست" onClose={close} busy={busy}>
      <label>
        پاسخ نمونه
        <select
          value={outcome}
          onChange={(event) => {
            setOutcome(event.target.value);
            setResult("");
          }}
        >
          <option value="submitted">پاسخ نامعلوم</option>
          <option value="error">خطا</option>
          <option value="activated">موفق</option>
        </select>
      </label>
      {result && <p role="status">نتیجهٔ شبیه‌سازی: {hamtaLabels[result]}</p>}
      {error && <p role="alert">{error}</p>}
      <div className="toolbar">
        <button
          className="primary"
          disabled={busy}
          onClick={() => void submit()}
        >
          اجرای شبیه‌سازی
        </button>
        <button type="button" onClick={close} disabled={busy}>
          بستن
        </button>
      </div>
    </ImeiDialog>
  );
}

/** @param {{unit:import("./api.js").Unit,close:()=>void}} props */
export function CorrectionEditor({ unit, close }) {
  const command = useCommand();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** @param {import("react").FormEvent<HTMLFormElement>} event */
  async function save(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await command("/imei/units/" + unit.id + "/official-corrections", {
        reference: form.get("reference"),
        reason: form.get("reason"),
      });
      close();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ImeiDialog title="ثبت ارجاع اصلاحیهٔ رسمی" onClose={close} busy={busy}>
      <form onSubmit={save}>
        <label>
          مرجع رسمی
          <input name="reference" required maxLength={240} />
        </label>
        <label>
          علت اصلاح
          <textarea name="reason" required maxLength={500} />
        </label>
        {error && <p role="alert">{error}</p>}
        <div className="toolbar">
          <button className="primary" disabled={busy}>
            ثبت ارجاع
          </button>
          <button type="button" onClick={close} disabled={busy}>
            انصراف
          </button>
        </div>
      </form>
    </ImeiDialog>
  );
}

/** @param {{unit:import("./api.js").Unit,close:()=>void,saved:()=>void}} props */
export function HamtaEvidenceEditor({ unit, close, saved }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [file, setFile] = useState(/** @type {File|null} */ (null));
  const [key, setKey] = useState(() => crypto.randomUUID());
  /** @param {import("react").FormEvent<HTMLFormElement>} event */
  async function save(event) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      await request("/imei/units/" + unit.id + "/hamta-evidence", {
        method: "POST",
        body: file,
        headers: {
          "Idempotency-Key": key,
          "X-Filename": encodeURIComponent(file.name),
        },
      });
      saved();
    } catch (cause) {
      setError(errorMessage(cause));
      if (cause instanceof RequestError && cause.status < 500)
        setKey(crypto.randomUUID());
    } finally {
      setBusy(false);
    }
  }
  return (
    <ImeiDialog title="پیوست شاهد همتا" onClose={close} busy={busy}>
      <form onSubmit={save}>
        <label>
          فایل شاهد
          <input
            name="evidence"
            type="file"
            required
            disabled={busy}
            accept=".pdf,.jpg,.jpeg,.png"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setKey(crypto.randomUUID());
            }}
          />
        </label>
        <p>PDF، JPG یا PNG تا ۱٫۵ مگابایت.</p>
        {error && <p role="alert">{error}</p>}
        <div className="toolbar">
          <button className="primary" disabled={busy}>
            ثبت شاهد
          </button>
          <button type="button" onClick={close} disabled={busy}>
            انصراف
          </button>
        </div>
      </form>
    </ImeiDialog>
  );
}
