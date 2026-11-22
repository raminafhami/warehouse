import { openPrintPreview } from "../components/PrintPreview.jsx";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Pagination } from "../components/Pagination.jsx";
import { useResource } from "../components/useResource.js";
import {
  deliveryStatus,
  requestStatus,
  useHandoverCommand,
} from "../handover/api.js";
import { errorMessage, request } from "../request/identity.js";
import { HandoverDetailPage } from "./HandoverDetailPage.jsx";

const empty =
  /** @type {{data:(import("../handover/api.js").Request|import("../handover/api.js").DeliveryEntry)[],count:number}} */ ({
    data: [],
    count: 0,
  });
const emptyOptions =
  /** @type {{models:import("../handover/api.js").Option[],warehouses:import("../handover/api.js").Option[],lines:import("../handover/api.js").Option[],pairs:{warehouseId:string,lineId:string}[]}} */ ({
    models: [],
    warehouses: [],
    lines: [],
    pairs: [],
  });

/** @param {{profile:import("../request/identity.js").Profile}} props */
export function HandoverPage({ profile }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [revision, reload] = useState(0);
  const [tab, setTab] = useState(
    /** @type {"requests"|"deliveries"} */ ("requests"),
  );
  const deliveries = tab === "deliveries";
  const statuses = deliveries ? deliveryStatus : requestStatus;
  const [page, setPage] = useState(0),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState("");
  const [editor, setEditor] = useState(false),
    [error, setError] = useState("");
  const query = new URLSearchParams({ page: String(page), q: search, status });
  const resource = useResource(
    "/handover/" + tab + "?" + query,
    empty,
    revision,
  );
  const selectedId = params.get("request") ?? resource.data.data[0]?.id;
  async function print() {
    try {
      await request("/handover/" + tab + "/export?" + query);
      openPrintPreview();
    } catch (error) {
      setError(errorMessage(error));
    }
  }
  return (
    <>
      <header className="page-header">
        <h1>درخواست و تحویل قطعات به تولید</h1>
        <div className="toolbar">
          {profile.permissions.includes("handover:pdf") && (
            <button
              disabled={resource.loading || Boolean(resource.error)}
              onClick={() => void print()}
            >
              PDF
            </button>
          )}
          {!deliveries && profile.permissions.includes("handover:create") && (
            <button className="primary" onClick={() => setEditor(true)}>
              ثبت درخواست قطعه
            </button>
          )}
        </div>
      </header>
      <div className="tabs catalog-tabs">
        {
          /** @type {const} */ ([
            ["requests", "درخواست‌ها"],
            ["deliveries", "حواله‌ها"],
          ]).map(([key, label]) => (
            <button
              key={key}
              aria-pressed={tab === key}
              onClick={() => {
                setTab(key);
                setParams({});
                setPage(0);
                setSearch("");
                setStatus("");
                setError("");
              }}
            >
              {label}
            </button>
          ))
        }
      </div>
      <div className={deliveries ? undefined : "split-detail"}>
        <section className="panel">
          <header className="panel-heading">
            <h2>{deliveries ? "حواله‌ها" : "درخواست‌های تولید"}</h2>
          </header>
          <div className="toolbar panel-pad">
            <label>
              جست‌وجو
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(0);
                }}
              />
            </label>
            <label>
              وضعیت
              <select
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(0);
                }}
              >
                <option value="">همه</option>
                {Object.entries(statuses).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {(error || resource.error) && (
            <p role="alert" className="panel-pad">
              {error || resource.error}
            </p>
          )}
          {!deliveries && (
            <ul className="record-list">
              {resource.data.data.map(
                (row) =>
                  !("requestCode" in row) && (
                    <li key={row.id}>
                      <Link
                        to={"?request=" + row.id}
                        aria-current={
                          row.id === selectedId ? "true" : undefined
                        }
                      >
                        <bdi>{row.code}</bdi>
                        <span
                          className={
                            row.status === "fulfilled"
                              ? "badge info"
                              : row.status === "open"
                                ? "badge warn"
                                : "badge"
                          }
                        >
                          {requestStatus[row.status]}
                        </span>
                        <small>
                          {row.modelName} · {row.count.toLocaleString("fa-IR")}{" "}
                          گوشی · {row.lineName}
                        </small>
                      </Link>
                    </li>
                  ),
              )}
            </ul>
          )}
          {deliveries && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {deliveries && <th>حواله</th>}
                    <th>درخواست</th>
                    <th>مدل</th>
                    {!deliveries && <th>تعداد گوشی</th>}
                    {!deliveries && <th>نسخهٔ BOM</th>}
                    <th>انبار</th>
                    <th>خط مقصد</th>
                    <th>وضعیت</th>
                  </tr>
                </thead>
                <tbody>
                  {resource.data.data.map((item) =>
                    "requestCode" in item ? (
                      <tr key={item.id}>
                        <td>
                          <Link dir="ltr" to={"/handover/" + item.requestId}>
                            {item.code}
                          </Link>
                        </td>
                        <td dir="ltr">{item.requestCode}</td>
                        <td>{item.modelName}</td>
                        <td>{item.warehouseName}</td>
                        <td>{item.lineName}</td>
                        <td>{deliveryStatus[item.status]}</td>
                      </tr>
                    ) : (
                      <tr key={item.id}>
                        <td>
                          <Link dir="ltr" to={"/handover/" + item.id}>
                            {item.code}
                          </Link>
                        </td>
                        <td>{item.modelName}</td>
                        <td>{item.count.toLocaleString("fa")}</td>
                        <td>{item.bomRevision.toLocaleString("fa")}</td>
                        <td>{item.warehouseName}</td>
                        <td>{item.lineName}</td>
                        <td>{requestStatus[item.status]}</td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          )}
          {resource.loading ? (
            <p role="status" className="panel-pad">
              در حال دریافت…
            </p>
          ) : (
            !resource.data.count && (
              <p className="panel-pad">
                {deliveries ? "حواله‌ای پیدا نشد." : "درخواستی پیدا نشد."}
              </p>
            )
          )}
          <Pagination
            page={page}
            count={resource.data.count}
            onPage={setPage}
          />
        </section>
        {!deliveries && (
          <div className="page-stack">
            {selectedId ? (
              <HandoverDetailPage
                key={selectedId}
                selectedId={selectedId}
                profile={profile}
                onUpdated={() => reload(revision + 1)}
              />
            ) : (
              <section className="panel detail-placeholder">
                {resource.loading
                  ? "در حال دریافت درخواست‌ها…"
                  : "یک درخواست تولید را برای آماده‌سازی تحویل انتخاب کنید."}
              </section>
            )}
          </div>
        )}
      </div>
      {editor && (
        <RequestEditor
          onClose={() => setEditor(false)}
          onCreated={(id) => void navigate("/handover/" + id)}
        />
      )}
    </>
  );
}

/** @param {{onClose:()=>void,onCreated:(id:string)=>void}} props */
function RequestEditor({ onClose, onCreated }) {
  const options = useResource("/handover/options", emptyOptions, 0);
  const dialog = useRef(/** @type {HTMLDialogElement|null} */ (null));
  const command = useHandoverCommand();
  const [warehouse, setWarehouse] = useState(""),
    [line, setLine] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lines = options.data.lines.filter((item) =>
    options.data.pairs.some(
      (pair) => pair.warehouseId === warehouse && pair.lineId === item.id,
    ),
  );
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  /** @param {import("react").FormEvent<HTMLFormElement>} event */
  async function save(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      /** @type {import("../handover/api.js").Request} */
      const result = await command("/handover/requests", {
        warehouseId: warehouse,
        lineId: line,
        modelId: form.get("modelId"),
        count: Number(form.get("count")),
      });
      onCreated(result.id);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      className="panel editor"
      ref={dialog}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2>ثبت درخواست قطعه بر اساس برنامهٔ تولید</h2>
      <form onSubmit={save}>
        <label>
          مدل گوشی
          <select name="modelId" required defaultValue="">
            <option value="">انتخاب مدل</option>
            {options.data.models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.code}
              </option>
            ))}
          </select>
        </label>
        <label>
          تعداد گوشی
          <input name="count" type="number" min={1} max={1000000} required />
        </label>
        <label>
          انبار مبدأ
          <select
            name="warehouseId"
            value={warehouse}
            onChange={(e) => {
              setWarehouse(e.target.value);
              setLine("");
            }}
            required
          >
            <option value="">انتخاب انبار</option>
            {options.data.warehouses.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.code}
              </option>
            ))}
          </select>
        </label>
        <label>
          خط تولید مقصد
          <select
            name="lineId"
            value={line}
            onChange={(e) => setLine(e.target.value)}
            required
          >
            <option value="">انتخاب خط</option>
            {lines.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.code}
              </option>
            ))}
          </select>
        </label>
        {(error || options.error) && (
          <p role="alert">{error || options.error}</p>
        )}
        <div className="toolbar">
          <button className="primary" disabled={busy || options.loading}>
            ثبت درخواست
          </button>
          <button type="button" disabled={busy} onClick={onClose}>
            انصراف
          </button>
        </div>
      </form>
    </dialog>
  );
}
