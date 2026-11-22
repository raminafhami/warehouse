import { useState } from "react";
import { Pagination } from "../components/Pagination.jsx";
import { useResource } from "../components/useResource.js";
import { errorMessage, request } from "../request/identity.js";
import { useOptions } from "./useOptions.js";

const empty =
  /** @type {{ data: import("./catalog.js").Revision[], count: number }} */ ({
    data: [],
    count: 0,
  });

/** @param {{ model: import("./catalog.js").Entry, editable: boolean, onClose?: () => void }} props */
export function Versions({ model, editable, onClose }) {
  const [type, setType] = useState("bom");
  const [line, setLine] = useState("");
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState(0);
  const picks = useOptions(
    type === "bom" ? ["skus", "stations"] : ["lines", "stations"],
  );
  const query = new URLSearchParams({
    type,
    modelId: model.id,
    page: String(page),
    ...(type === "routing" && line ? { lineId: line } : {}),
  });
  const versions = useResource("/master/versions?" + query, empty, revision);
  const stations = (picks.entries.stations ?? []).filter(
    (item) => type === "bom" || item.parentId === line,
  );
  const [rows, setRows] = useState([0]);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  /** @param {import("react").FormEvent<HTMLFormElement>} event */
  async function publish(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await request("/master/versions", {
        method: "POST",
        body: {
          type,
          modelId: model.id,
          lineId: line || undefined,
          description: form.get("description"),
          lines:
            type === "bom"
              ? rows.map((key) => ({
                  skuId: form.get("sku-" + key),
                  quantity: form.get("quantity-" + key),
                  stationCode: form.get("station-" + key),
                }))
              : undefined,
          stationIds:
            type === "routing"
              ? rows.map((key) => form.get("station-" + key))
              : undefined,
        },
      });
      setEditing(false);
      setPage(0);
      setRevision((value) => value + 1);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel panel-pad version-panel">
      <div className="page-header">
        <h2>
          {type === "bom" ? "فهرست قطعات (BOM)" : "مسیر تولید"} · {model.name}
        </h2>
        {onClose && <button onClick={onClose}>بستن</button>}
      </div>
      <div className="toolbar">
        <label>
          نوع
          <select
            value={type}
            onChange={(event) => {
              setType(event.target.value);
              setPage(0);
              setEditing(false);
              setError("");
            }}
          >
            <option value="bom">فهرست قطعات (BOM)</option>
            <option value="routing">مسیر تولید</option>
          </select>
        </label>
        {type === "routing" && (
          <label>
            خط تولید
            <select
              value={line}
              onChange={(event) => {
                setLine(event.target.value);
                setPage(0);
                setEditing(false);
                setError("");
              }}
            >
              <option value="">همهٔ خطوط</option>
              {picks.entries.lines?.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.code} · {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {editable && model.active && (
          <button
            className="primary"
            disabled={picks.loading || (type === "routing" && !line)}
            onClick={() => {
              setRows([0]);
              setError("");
              setEditing(true);
            }}
          >
            نسخهٔ جدید
          </button>
        )}
      </div>
      {editing && (
        <form className="version-editor" onSubmit={publish}>
          <label>
            توضیح نسخه
            <input name="description" />
          </label>
          {rows.map((key, index) => (
            <fieldset key={key}>
              <legend>ردیف {(index + 1).toLocaleString("fa")}</legend>
              {type === "bom" && (
                <>
                  <label>
                    کد کالا
                    <select name={"sku-" + key} required>
                      <option value="">انتخاب</option>
                      {picks.entries.skus?.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.code} · {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    مقدار
                    <input
                      name={"quantity-" + key}
                      inputMode="decimal"
                      dir="ltr"
                      defaultValue="1"
                      required
                    />
                  </label>
                </>
              )}
              <label>
                ایستگاه
                <select name={"station-" + key} required>
                  <option value="">انتخاب</option>
                  {(type === "bom"
                    ? [
                        ...new Map(
                          stations.map((item) => [item.code, item]),
                        ).values(),
                      ]
                    : stations
                  ).map((item) => (
                    <option
                      key={item.id}
                      value={type === "bom" ? item.code : item.id}
                    >
                      {item.code} · {item.name}
                    </option>
                  ))}
                </select>
              </label>
              {rows.length > 1 && (
                <button
                  type="button"
                  onClick={() =>
                    setRows((value) => value.filter((item) => item !== key))
                  }
                >
                  حذف ردیف
                </button>
              )}
            </fieldset>
          ))}
          <div className="toolbar">
            <button
              type="button"
              onClick={() =>
                setRows((value) => [...value, Math.max(...value) + 1])
              }
              disabled={rows.length >= 150}
            >
              افزودن ردیف
            </button>
            <button className="primary" disabled={busy}>
              انتشار نسخه
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setError("");
              }}
            >
              انصراف
            </button>
          </div>
        </form>
      )}
      {(error || versions.error || picks.error) && (
        <p role="alert">{error || versions.error || picks.error}</p>
      )}
      {versions.loading ? (
        <p role="status">در حال دریافت نسخه‌ها…</p>
      ) : (
        !versions.data.count && <p>نسخه‌ای منتشر نشده است.</p>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>نسخه</th>
              <th>تاریخ</th>
              <th>توضیح</th>
              <th>جزئیات</th>
            </tr>
          </thead>
          <tbody>
            {versions.data.data.map((item) => (
              <tr key={item.id}>
                <td>{item.revision.toLocaleString("fa")}</td>
                <td>{new Date(item.createdAt).toLocaleDateString("fa-IR")}</td>
                <td>{item.description || "—"}</td>
                <td>
                  <details>
                    <summary>مشاهده</summary>
                    <ol>
                      {item.lines?.map((entry) => (
                        <li key={entry.skuId}>
                          {entry.skuCode} · {entry.quantity} ·{" "}
                          {entry.stationCode}
                        </li>
                      )) ??
                        item.steps?.map((step) => (
                          <li key={step.stationId}>
                            {step.stationCode} ·{" "}
                            {String(step.configuration.stationName)}
                          </li>
                        ))}
                    </ol>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination page={page} count={versions.data.count} onPage={setPage} />
    </section>
  );
}
