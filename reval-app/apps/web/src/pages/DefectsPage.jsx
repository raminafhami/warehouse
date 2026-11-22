import { openPrintPreview } from "../components/PrintPreview.jsx";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { partStatus } from "../basket/api.js";
import { Pagination } from "../components/Pagination.jsx";
import { StatusStrip } from "../components/StatusStrip.jsx";
import { useResource } from "../components/useResource.js";
import { errorMessage } from "../request/identity.js";
import { useCommand } from "../request/useCommand.js";
import { caseStatus } from "./DefectActions.jsx";

/** @typedef {import('./DefectActions.jsx').Defect} Defect */
/** @typedef {import('../basket/api.js').Part & {returnId?:string,defectId?:string,canSelect:boolean,canPrint:boolean}} Part */
/** @typedef {{id:string,code:string,supplierName:string,status:keyof typeof returnStatus,version:number,parts:{id:string,code:string,skuCode:string,quantity:string}[],events:{action:keyof typeof returnStatus,reference?:string,at:string}[],canTransfer:boolean,canPrint:boolean}} Return */
const returnStatus = {
  prepared: "آمادهٔ ارسال",
  dispatched: "ارسال‌شده",
  delivered: "تحویل تأمین‌کننده",
};
const tabs = {
  cases: "پرونده‌های خرابی",
  parts: "دریافت در انبار معیوبی",
  returns: "مرجوعی به تأمین‌کننده",
};

/** @param {{technical?:boolean,replacements?:boolean,permissions?:string[]}} props */
export function DefectsPage({
  technical = false,
  replacements = false,
  permissions = [],
}) {
  const [tab, setTab] = useState(/** @type {keyof typeof tabs} */ ("cases")),
    [page, setPage] = useState(0),
    [revision, reload] = useState(0),
    [selected, select] = useState(/** @type {string[]} */ ([])),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const navigate = useNavigate(),
    command = useCommand();
  const {
    data,
    loading,
    error: loadError,
  } = useResource(
    "/defects/" +
      tab +
      "?page=" +
      page +
      (technical
        ? "&technical=true"
        : replacements
          ? "&replacements=true"
          : ""),
    /** @type {{items:(Defect|Part|Return)[],count:number,canPrint?:boolean}} */ ({
      items: [],
      count: 0,
    }),
    revision,
  );
  const normal = !technical && !replacements;
  const cases = useResource(
    normal ? "/defects/cases?size=1" : null,
    { count: 0 },
    revision,
  );
  const parts = useResource(
    normal ? "/defects/parts?size=1" : null,
    { count: 0 },
    revision,
  );
  const returns = useResource(
    normal ? "/defects/returns?size=1" : null,
    { count: 0 },
    revision,
  );
  /** @param {import('react').FormEvent<HTMLFormElement>} event */
  async function receive(event) {
    event.preventDefault();
    const form = event.currentTarget,
      code = new FormData(form).get("code");
    setBusy(true);
    setError("");
    try {
      await command("/defects/receive", { code });
      form.reset();
      reload((value) => value + 1);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function create() {
    setBusy(true);
    setError("");
    try {
      /** @type {Return} */
      const row = await command("/defects/returns", { partIds: selected });
      navigate("/defects/returns/" + row.id);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  const heading = technical
    ? "ارجاع‌های فنی"
    : replacements
      ? "پرونده‌های تعویض قطعه"
      : tabs[tab];
  return (
    <div className="page-stack">
      {normal && <h1>قطعات معیوب، انبار معیوبی و مرجوعی</h1>}
      {normal && (
        <StatusStrip
          items={[
            {
              label: tabs.cases,
              value:
                cases.loading || cases.error ? undefined : cases.data.count,
            },
            {
              label: tabs.parts,
              value:
                parts.loading || parts.error ? undefined : parts.data.count,
            },
            {
              label: tabs.returns,
              value:
                returns.loading || returns.error
                  ? undefined
                  : returns.data.count,
            },
            {
              label: "ردیف‌های این صفحه",
              value: loading ? undefined : data.items.length,
            },
          ]}
        />
      )}
      {normal && (
        <div className="tabs">
          {Object.entries(tabs).map(([id, label]) => (
            <button
              key={id}
              aria-pressed={tab === id}
              onClick={() => {
                setTab(/** @type {keyof typeof tabs} */ (id));
                setPage(0);
                select([]);
                setError("");
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <section className="panel panel-pad page-stack">
        <h2>{heading}</h2>
        {tab === "parts" && (
          <div className="toolbar">
            {permissions.includes("defects:scan") && (
              <form className="toolbar" onSubmit={receive}>
                <label>
                  بارکد قطعهٔ معیوب <input name="code" required dir="ltr" />
                </label>
                <button disabled={busy}>دریافت در قرنطینه</button>
              </form>
            )}
            {permissions.includes("defects:create") && (
              <button
                disabled={busy || loading || !selected.length}
                onClick={() => void create()}
              >
                ایجاد سند مرجوعی
              </button>
            )}
            {data.canPrint && (
              <button onClick={() => openPrintPreview()}>
                PDF قطعات معیوب
              </button>
            )}
          </div>
        )}
        {(error || loadError) && <p role="alert">{error || loadError}</p>}
        {!loading && !data.count && <p>رکوردی پیدا نشد.</p>}
        {!!data.items.length && (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {(tab === "parts"
                    ? ["برچسب", "کالا و مقدار", "وضعیت", "سند"]
                    : tab === "returns"
                      ? ["سند", "تأمین‌کننده", "وضعیت", "تعداد اقلام"]
                      : ["گوشی", "تست", "وضعیت", "شرح"]
                  ).map((label) => (
                    <th key={label}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.items.map((row) => {
                  if ("unitCode" in row)
                    return (
                      <tr key={row.id}>
                        <td>
                          <Link to={"/defects/cases/" + row.id}>
                            {row.unitCode}
                          </Link>
                        </td>
                        <td>{row.testName}</td>
                        <td>{caseStatus[row.status]}</td>
                        <td>{row.reason}</td>
                      </tr>
                    );
                  if ("supplierName" in row)
                    return (
                      <tr key={row.id}>
                        <td>
                          <Link to={"/defects/returns/" + row.id}>
                            {row.code}
                          </Link>
                        </td>
                        <td>{row.supplierName}</td>
                        <td>{returnStatus[row.status]}</td>
                        <td>{row.parts.length}</td>
                      </tr>
                    );
                  return (
                    <tr key={row.id}>
                      <td>
                        {row.state === "defect_store" &&
                          !row.returnId &&
                          row.canSelect && (
                            <input
                              aria-label={"انتخاب " + row.code}
                              type="checkbox"
                              checked={selected.includes(row.id)}
                              onChange={(event) =>
                                select(
                                  event.target.checked
                                    ? [...selected, row.id]
                                    : selected.filter((id) => id !== row.id),
                                )
                              }
                            />
                          )}{" "}
                        {row.defectId ? (
                          <Link to={"/defects/cases/" + row.defectId}>
                            {row.code}
                          </Link>
                        ) : (
                          row.code
                        )}
                      </td>
                      <td>
                        {row.skuCode} · {row.quantity}
                      </td>
                      <td>{partStatus[row.state]}</td>
                      <td>
                        {row.returnId ? (
                          <Link to={"/defects/returns/" + row.returnId}>
                            سند مرجوعی
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} count={data.count} onPage={setPage} />
      </section>
    </div>
  );
}

export function SupplierReturnPage() {
  const { id } = useParams(),
    path = "/defects/returns/" + id;
  const [revision, reload] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const command = useCommand();
  const {
    data,
    loading,
    error: loadError,
  } = useResource(path, /** @type {Return|null} */ (null), revision);
  if (!data)
    return (
      <p role={loadError ? "alert" : "status"}>
        {loadError || "در حال دریافت سند…"}
      </p>
    );
  const next = data.status === "prepared" ? "dispatched" : "delivered";
  return (
    <div className="page-stack">
      <h1>سند مرجوعی {data.code}</h1>
      <section className="panel panel-pad page-stack">
        <p>
          {data.supplierName} · {returnStatus[data.status]}
        </p>
        {data.canPrint && (
          <div className="toolbar">
            <button onClick={() => openPrintPreview()}>PDF سند مرجوعی</button>
          </div>
        )}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>برچسب</th>
                <th>کالا</th>
                <th>مقدار</th>
              </tr>
            </thead>
            <tbody>
              {data.parts.map((part) => (
                <tr key={part.id}>
                  <td>{part.code}</td>
                  <td>{part.skuCode}</td>
                  <td>{part.quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.events.map((event) => (
          <p key={event.action}>
            {returnStatus[event.action]} ·{" "}
            {new Date(event.at).toLocaleString("fa-IR")}{" "}
            {event.reference && " · " + event.reference}
          </p>
        ))}
        {data.canTransfer && data.status !== "delivered" && (
          <form
            key={data.status}
            className="toolbar"
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError("");
              try {
                await command(path + "/advance", {
                  version: data.version,
                  status: next,
                  reference: new FormData(event.currentTarget).get("reference"),
                });
                reload((value) => value + 1);
              } catch (error) {
                setError(errorMessage(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              {next === "dispatched"
                ? "شمارهٔ حواله یا بارنامه"
                : "مرجع رسید تأمین‌کننده"}{" "}
              <input name="reference" required maxLength={160} />
            </label>
            <button disabled={busy || loading}>
              {next === "dispatched" ? "ثبت ارسال" : "ثبت تحویل تأمین‌کننده"}
            </button>
          </form>
        )}
        {(error || loadError) && <p role="alert">{error || loadError}</p>}
      </section>
    </div>
  );
}
