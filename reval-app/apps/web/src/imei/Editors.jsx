import { useState } from "react";
import { errorMessage } from "../request/identity.js";
import { useCommand } from "../request/useCommand.js";
import { errorLabels } from "./api.js";
import { ImeiDialog } from "./Dialog.jsx";
import { parseTextRows, readImportFile } from "./importFile.js";

/** @param {{options:import("./api.js").Options,close:()=>void,updated:()=>void}} props */
export function ImportEditor({ options, close, updated }) {
  const command = useCommand();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState(
    /** @type {import("./api.js").ImportReport|null} */ (null),
  );
  /** @param {import("react").FormEvent<HTMLFormElement>} event */
  async function save(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const file = form.get("file");
    const pasted = String(form.get("rows") ?? "");
    const selected = file instanceof File && file.size ? file : null;
    setBusy(true);
    setError("");
    try {
      if (selected && pasted.trim()) {
        setError("فایل یا متن را انتخاب کنید.");
        return;
      }
      let rows;
      try {
        rows = selected
          ? await readImportFile(selected)
          : parseTextRows(pasted);
      } catch (cause) {
        setError(
          cause instanceof Error && /^[\u0600-\u06ff]/.test(cause.message)
            ? cause.message
            : "فایل خوانده نشد. قالب و شیت اول را بررسی کنید.",
        );
        return;
      }
      if (!rows.length || rows.length > 1000) {
        setError("هر بار بین ۱ و ۱۰۰۰ ردیف IMEI وارد کنید.");
        return;
      }
      /** @type {import("./api.js").ImportReport} */
      const result = await command("/imei/imports", {
        modelId: form.get("modelId"),
        source: selected?.name ?? "ورود دستی",
        rows,
      });
      setReport(result);
      updated();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ImeiDialog title="بارگذاری فهرست IMEI مجاز" onClose={close} busy={busy}>
      {report ? (
        <>
          <ImportReport report={report} />
          <button onClick={close}>بستن</button>
        </>
      ) : (
        <form onSubmit={save}>
          <label>
            مدل گوشی
            <select name="modelId" required defaultValue="">
              <option value="">انتخاب مدل</option>
              {options.models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.imeiSlots.toLocaleString("fa")} IMEI
                </option>
              ))}
            </select>
          </label>
          <label>
            فایل فهرست
            <input name="file" type="file" accept=".xlsx,.csv,.txt" />
          </label>
          <label>
            یا فهرست را وارد کنید
            <textarea name="rows" rows={6} maxLength={85000} dir="ltr" />
          </label>
          <p>
            برای هر گوشی یک ردیف وارد کنید. برای دو شناسه از ویرگول یا دو ستون
            IMEI1 و IMEI2 استفاده کنید. از فایل اکسل شیت اول خوانده می‌شود.
          </p>
          {error && <p role="alert">{error}</p>}
          <div className="toolbar">
            <button className="primary" disabled={busy}>
              ثبت فهرست
            </button>
            <button type="button" onClick={close} disabled={busy}>
              انصراف
            </button>
          </div>
        </form>
      )}
    </ImeiDialog>
  );
}

/** @param {{report:import("./api.js").ImportReport}} props */
export function ImportReport({ report }) {
  return (
    <>
      <p role="status">
        {report.accepted.toLocaleString("fa")} ردیف ثبت شد.{" "}
        {report.errors.length.toLocaleString("fa")} ردیف رد شد.
      </p>
      <p>
        {report.modelName} · {report.source}
      </p>
      {report.errors.length > 0 && (
        <ol>
          {report.errors.map(({ row, code }, index) => (
            <li key={index}>
              ردیف {row.toLocaleString("fa")} · {errorLabels[code]}
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

/** @param {{options:import("./api.js").Options,close:()=>void,created:(id:string)=>void}} props */
export function OrderEditor({ options, close, created }) {
  const command = useCommand();
  const [modelId, setModel] = useState("");
  const [colorId, setColor] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const model = options.models.find((entry) => entry.id === modelId);
  /** @param {import("react").FormEvent<HTMLFormElement>} event */
  async function save(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      /** @type {import("./api.js").Order} */
      const order = await command("/imei/orders", {
        modelId,
        colorId,
        count: Number(form.get("count")),
        lineId: form.get("lineId"),
      });
      created(order.id);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ImeiDialog title="ثبت دستور تولید" onClose={close} busy={busy}>
      <form onSubmit={save}>
        <label>
          مدل
          <select
            name="modelId"
            value={modelId}
            onChange={(event) => {
              setModel(event.target.value);
              setColor("");
            }}
            required
          >
            <option value="">انتخاب مدل</option>
            {options.models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          رنگ
          <select
            name="colorId"
            value={colorId}
            onChange={(event) => setColor(event.target.value)}
            required
          >
            <option value="">انتخاب رنگ</option>
            {options.colors
              .filter((item) => model?.colorIds.includes(item.id))
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          تعداد
          <input name="count" type="number" required min={1} max={1000000} />
        </label>
        <label>
          خط تولید
          <select name="lineId" required defaultValue="">
            <option value="">انتخاب خط</option>
            {options.lines.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        {error && <p role="alert">{error}</p>}
        <div className="toolbar">
          <button className="primary" disabled={busy}>
            ثبت دستور
          </button>
          <button type="button" onClick={close} disabled={busy}>
            انصراف
          </button>
        </div>
      </form>
    </ImeiDialog>
  );
}
