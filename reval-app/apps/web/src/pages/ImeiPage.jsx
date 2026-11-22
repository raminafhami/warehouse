import { openPrintPreview } from "../components/PrintPreview.jsx";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Pagination } from "../components/Pagination.jsx";
import { StatusStrip } from "../components/StatusStrip.jsx";
import { useResource } from "../components/useResource.js";
import { errorMessage, request } from "../request/identity.js";
import { emptyOptions, hamtaLabels, pairLabels } from "../imei/api.js";
import { ImeiDialog } from "../imei/Dialog.jsx";
import { ImportEditor, ImportReport, OrderEditor } from "../imei/Editors.jsx";
import {
  CorrectionEditor,
  HamtaDemo,
  HamtaEvidenceEditor,
  HamtaEditor,
} from "../imei/HamtaEditor.jsx";

/** @typedef {import("../imei/api.js").Pair|import("../imei/api.js").Order|import("../imei/api.js").Unit} Row */
/** @typedef {import("../imei/api.js").Unit} Unit */
const tabs = /** @type {const} */ ([
  ["pool", "فهرست IMEI مجاز"],
  ["hamta", "فعال‌سازی همتا"],
  ["orders", "برنامه و دستور تولید"],
]);
const empty = /** @type {{data:Row[],count:number}} */ ({ data: [], count: 0 });

/** @param {{profile:import("../request/identity.js").Profile}} props */
export function ImeiPage({ profile }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = tabs.find(([key]) => key === params.get("tab"))?.[0] ?? "pool";
  const [q, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(0);
  const [rev, update] = useState(0);
  const [panel, setPanel] = useState(
    /** @type {""|"import"|"order"|"imports"|"hamta"|"demo"|"correction"|"evidence"} */ (
      ""
    ),
  );
  const [ids, setIds] = useState(/** @type {string[]} */ ([]));
  const [editing, setEditing] = useState(/** @type {Unit[]} */ ([]));
  const [error, setError] = useState("");
  const options = useResource("/imei/options", emptyOptions, 0);
  const query = new URLSearchParams({ page: String(page), q, status });
  const list = useResource("/imei/" + tab + "?" + query, empty, rev);
  const pool = useResource("/imei/pool?size=1", empty, rev);
  const free = useResource("/imei/pool?size=1&status=free", empty, rev);
  const orders = useResource("/imei/orders?size=1", empty, rev);
  const hamta = useResource("/imei/hamta?size=1", empty, rev);
  const listUnits = list.data.data.filter((row) => "orderCode" in row);
  const selected = listUnits.filter((row) => ids.includes(row.id));
  const eligible = selected.every(
    (item) =>
      (item.hamtaStatus === "pending") ===
      (selected[0]?.hamtaStatus === "pending"),
  );
  const statuses = tab === "pool" ? pairLabels : hamtaLabels;
  const close = () => setPanel("");
  const refresh = () => {
    update((value) => value + 1);
    setIds([]);
  };
  async function print() {
    try {
      await request("/imei/" + tab + "/export?" + query);
      openPrintPreview();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  return (
    <>
      <header className="page-header">
        <h1>مدیریت IMEI و برنامه تولید</h1>
        <div className="toolbar">
          {profile.permissions.includes("imei:pdf") && (
            <button
              disabled={list.loading || Boolean(list.error)}
              onClick={() => void print()}
            >
              PDF
            </button>
          )}
          {tab === "pool" && options.data.canImport && (
            <button className="primary" onClick={() => setPanel("import")}>
              بارگذاری IMEI مجاز
            </button>
          )}
          {tab === "pool" && options.data.canViewImports && (
            <button onClick={() => setPanel("imports")}>سوابق ورود</button>
          )}
          {tab === "orders" && options.data.lines.length > 0 && (
            <button className="primary" onClick={() => setPanel("order")}>
              دستور تولید
            </button>
          )}
          {tab === "hamta" && options.data.demo && (
            <button onClick={() => setPanel("demo")}>شبیه‌سازی همتا</button>
          )}
          {tab === "hamta" && selected.length > 0 && (
            <button
              className="primary"
              disabled={!eligible}
              onClick={() => {
                setEditing(selected);
                setPanel("hamta");
              }}
            >
              ثبت گروهی نتیجه
            </button>
          )}
        </div>
      </header>
      <StatusStrip
        items={[
          {
            label: "فهرست IMEI مجاز",
            value: pool.loading || pool.error ? undefined : pool.data.count,
          },
          {
            label: "آزاد",
            value: free.loading || free.error ? undefined : free.data.count,
          },
          {
            label: "فعال‌سازی همتا",
            value: hamta.loading || hamta.error ? undefined : hamta.data.count,
          },
          {
            label: "دستور تولید",
            value:
              orders.loading || orders.error ? undefined : orders.data.count,
          },
        ]}
      />
      <div className="tabs catalog-tabs">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            aria-pressed={tab === key}
            onClick={() => {
              setParams(key === "pool" ? {} : { tab: key });
              setQuery("");
              setStatus("");
              setPage(0);
              setIds([]);
              setError("");
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <section className="panel">
        <div className="toolbar panel-pad">
          <label>
            جست‌وجو
            <input
              value={q}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(0);
                setIds([]);
              }}
            />
          </label>
          {tab !== "orders" && (
            <label>
              وضعیت
              <select
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value);
                  setPage(0);
                  setIds([]);
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
          )}
        </div>
        {(error || list.error || options.error) && (
          <p className="panel-pad" role="alert">
            {error || list.error || options.error}
          </p>
        )}
        {!eligible && (
          <p className="panel-pad" role="status">
            گوشی‌های آمادهٔ ثبت اولیه و گوشی‌های نیازمند تطبیق را جدا انتخاب
            کنید.
          </p>
        )}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {(tab === "pool"
                  ? ["IMEI1", "IMEI2", "مدل", "وضعیت"]
                  : tab === "orders"
                    ? [
                        "دستور",
                        "مدل",
                        "رنگ",
                        "خط",
                        "تخصیص / برنامه",
                        "نسخه BOM / مسیر",
                      ]
                    : [
                        "انتخاب",
                        "گوشی",
                        "IMEI",
                        "مدل",
                        "خط",
                        "وضعیت",
                        "کد رهگیری",
                        "عملیات",
                      ]
                ).map((label) => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.data.data.map((row) => {
                if ("orderCode" in row)
                  return (
                    <tr key={row.id}>
                      <td>
                        {row.canApprove && row.hamtaStatus !== "activated" && (
                          <input
                            type="checkbox"
                            aria-label={"انتخاب " + row.code}
                            checked={ids.includes(row.id)}
                            onChange={(event) => {
                              setIds(
                                event.target.checked
                                  ? [...ids, row.id]
                                  : ids.filter((id) => id !== row.id),
                              );
                            }}
                          />
                        )}
                      </td>
                      <td dir="ltr">{row.code}</td>
                      <td dir="ltr">{row.numbers.join(" / ")}</td>
                      <td>{row.modelName}</td>
                      <td>{row.lineName}</td>
                      <td>
                        {row.hamtaStatus && hamtaLabels[row.hamtaStatus]}
                        {row.hamtaReason && <div>{row.hamtaReason}</div>}
                      </td>
                      <td dir="ltr">{row.trackingCode ?? "—"}</td>
                      <td>
                        {row.canApprove &&
                          (row.hamtaStatus === "activated" ? (
                            <button
                              onClick={() => {
                                setEditing([row]);
                                setPanel("correction");
                              }}
                            >
                              ارجاع اصلاحیه
                            </button>
                          ) : (
                            <button
                              onClick={() => {
                                setEditing([row]);
                                setPanel("hamta");
                              }}
                            >
                              ثبت نتیجه
                            </button>
                          ))}

                        {row.evidenceFile ? (
                          <a
                            href={
                              "/api/v1/imei/units/" + row.id + "/hamta-evidence"
                            }
                            download
                          >
                            {row.evidenceFile.name}
                          </a>
                        ) : (
                          row.canApprove &&
                          row.hamtaStatus === "activated" && (
                            <button
                              onClick={() => {
                                setEditing([row]);
                                setPanel("evidence");
                              }}
                            >
                              پیوست شاهد
                            </button>
                          )
                        )}
                      </td>
                    </tr>
                  );
                if ("colorName" in row)
                  return (
                    <tr key={row.id}>
                      <td>
                        <Link dir="ltr" to={"/imei/orders/" + row.id}>
                          {row.code}
                        </Link>
                      </td>
                      <td>{row.modelName}</td>
                      <td>{row.colorName}</td>
                      <td>{row.lineName}</td>
                      <td>
                        {row.allocated.toLocaleString("fa")} /{" "}
                        {row.count.toLocaleString("fa")}
                      </td>
                      <td>
                        {row.bomRevision.toLocaleString("fa")} /{" "}
                        {row.routingRevision.toLocaleString("fa")}
                      </td>
                    </tr>
                  );
                return (
                  <tr key={row.id}>
                    <td dir="ltr">{row.numbers[0]}</td>
                    <td dir="ltr">{row.numbers[1] ?? "—"}</td>
                    <td>{row.modelName}</td>
                    <td>
                      {
                        pairLabels[
                          row.status === "void"
                            ? "void"
                            : (row.hamtaStatus ??
                              (row.hasError ? "error" : row.status))
                        ]
                      }
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {list.loading ? (
          <p className="panel-pad" role="status">
            در حال دریافت…
          </p>
        ) : (
          !list.data.count && <p className="panel-pad">رکوردی پیدا نشد.</p>
        )}
        <Pagination
          page={page}
          count={list.data.count}
          onPage={(next) => {
            setPage(next);
            setIds([]);
          }}
        />
      </section>
      {panel === "import" && (
        <ImportEditor options={options.data} close={close} updated={refresh} />
      )}
      {panel === "order" && (
        <OrderEditor
          options={options.data}
          close={close}
          created={(id) => void navigate("/imei/orders/" + id)}
        />
      )}
      {panel === "imports" && <ImportHistory close={close} />}
      {panel === "hamta" && (
        <HamtaEditor
          units={editing}
          close={close}
          saved={() => {
            close();
            refresh();
          }}
        />
      )}
      {panel === "demo" && <HamtaDemo close={close} />}
      {panel === "evidence" && (
        <HamtaEvidenceEditor
          unit={editing[0]}
          close={close}
          saved={() => {
            close();
            refresh();
          }}
        />
      )}
      {panel === "correction" && (
        <CorrectionEditor unit={editing[0]} close={close} />
      )}
    </>
  );
}

/** @param {{close:()=>void}} props */
function ImportHistory({ close }) {
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState(
    /** @type {import("../imei/api.js").ImportReport|null} */ (null),
  );
  const history = useResource(
    "/imei/imports?page=" + page,
    /** @type {{data:import("../imei/api.js").ImportReport[],count:number}} */ ({
      data: [],
      count: 0,
    }),
    0,
  );
  return (
    <ImeiDialog title="سوابق ورود فهرست IMEI" onClose={close}>
      {history.error && <p role="alert">{history.error}</p>}
      {selected ? (
        <>
          <ImportReport report={selected} />
          <button onClick={() => setSelected(null)}>بازگشت به سوابق</button>
        </>
      ) : (
        <>
          {history.loading ? (
            <p role="status">در حال دریافت…</p>
          ) : (
            !history.data.count && <p>سابقه‌ای پیدا نشد.</p>
          )}
          <ul>
            {history.data.data.map((item) => (
              <li key={item.id}>
                <button onClick={() => setSelected(item)}>
                  {item.source} · {item.modelName} ·{" "}
                  {item.accepted.toLocaleString("fa")} ثبت
                </button>
              </li>
            ))}
          </ul>
          <Pagination page={page} count={history.data.count} onPage={setPage} />
        </>
      )}
      <button onClick={close}>بستن</button>
    </ImeiDialog>
  );
}
