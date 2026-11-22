import { openPrintPreview } from "../components/PrintPreview.jsx";
import { DefectsPage } from "./DefectsPage.jsx";
import { useState } from "react";
import { Link } from "react-router-dom";
import { outcomes } from "../assembly/api.js";
import { Pagination } from "../components/Pagination.jsx";
import { StatusStrip } from "../components/StatusStrip.jsx";
import { useResource } from "../components/useResource.js";

const tabs = {
  results: "نتایج تست‌ها",
  technical: "ارجاع‌های فنی",
  retests: "تعویض‌ها و تست مجدد",
  rates: "نرخ خرابی هر تست",
  testing: "صف کنترل کیفیت",
};
/** @typedef {keyof typeof tabs} Tab */
/** @typedef {import('../assembly/api.js').Visit|import('../assembly/api.js').Result|import('../assembly/api.js').Rate} Row */
/** @param {{pdf:boolean}} props */
export function StageQcPage({ pdf }) {
  const [tab, setTab] = useState(/** @type {Tab} */ ("results"));
  const [outcome, setOutcome] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [revision, reload] = useState(0);
  const params = new URLSearchParams({ page: String(page), tab, q: search });
  if (outcome && tab !== "rates") params.set("outcome", outcome);
  const record = useResource(
    tab === "technical"
      ? null
      : (tab === "testing" ? "/assembly/testing?" : "/assembly/results?") +
          params,
    /** @type {{items:Row[],count:number}} */ ({ items: [], count: 0 }),
    revision,
  );
  const queue = useResource(
    "/assembly/testing?size=1",
    /** @type {{count:number}} */ ({ count: 0 }),
    revision,
  );
  const allResults = useResource(
    "/assembly/results?tab=results&size=1",
    /** @type {{count:number}} */ ({ count: 0 }),
    revision,
  );
  const rejected = useResource(
    "/assembly/results?tab=results&outcome=fail&size=1",
    /** @type {{count:number}} */ ({ count: 0 }),
    revision,
  );
  const reviews = useResource(
    "/assembly/results?tab=results&outcome=review&size=1",
    /** @type {{count:number}} */ ({ count: 0 }),
    revision,
  );
  const headings = {
    testing: ["گوشی", "مدل", "خط", "ایستگاه", "زمان تکمیل"],
    technical: [],
    results: ["گوشی", "ایستگاه", "تست", "نتیجه", "تلاش / نسخه", "زمان"],
    retests: ["گوشی", "ایستگاه", "تست", "نتیجه", "تلاش / نسخه", "زمان"],
    rates: [
      "تعریف تست",
      "نسخهٔ مسیر",
      "تلاش‌ها",
      "رد",
      "نیازمند بررسی",
      "درصد رد",
    ],
  };
  return (
    <div className="page-stack">
      <h1>کنترل کیفیت مرحله‌ای</h1>
      <StatusStrip
        items={[
          {
            label: "همه نتایج",
            value:
              allResults.loading || allResults.error
                ? undefined
                : allResults.data.count,
          },
          {
            label: "مردود",
            value:
              rejected.loading || rejected.error
                ? undefined
                : rejected.data.count,
          },
          {
            label: "نیازمند بررسی",
            value:
              reviews.loading || reviews.error ? undefined : reviews.data.count,
          },
          {
            label: "صف کنترل کیفیت",
            value: queue.loading || queue.error ? undefined : queue.data.count,
          },
        ]}
      />
      <div className="tabs" aria-label="نمای کیفیت مرحله‌ای">
        {Object.entries(tabs).map(([id, label]) => (
          <button
            key={id}
            aria-pressed={tab === id}
            onClick={() => {
              setTab(/** @type {Tab} */ (id));
              setPage(0);
              setOutcome("");
              setSearch("");
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "technical" ? (
        <DefectsPage technical />
      ) : (
        <section className="panel">
          <h2 className="panel-heading">{tabs[tab]}</h2>
          {tab === "retests" && <DefectsPage replacements />}
          <div className="toolbar panel-pad">
            {tab !== "testing" && (
              <label>
                جستجو{" "}
                <input
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setPage(0);
                  }}
                />
              </label>
            )}
            {(tab === "results" || tab === "retests") && (
              <label>
                نتیجه{" "}
                <select
                  value={outcome}
                  onChange={(event) => {
                    setOutcome(event.target.value);
                    setPage(0);
                  }}
                >
                  <option value="">همه</option>
                  {Object.entries(outcomes).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button onClick={() => reload(revision + 1)}>به‌روزرسانی</button>
            {pdf && tab !== "testing" && (
              <button onClick={() => openPrintPreview()}>PDF این صفحه</button>
            )}
          </div>
          {record.error && (
            <p className="panel-pad" role="alert">
              {record.error}
            </p>
          )}
          {!record.loading && !record.data.count && (
            <p className="panel-pad">رکوردی پیدا نشد.</p>
          )}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {headings[tab].map((item) => (
                    <th key={item}>{item}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {record.data.items.map((row) => {
                  if ("total" in row)
                    return (
                      <tr key={row._id.testId + row._id.routingVersionId}>
                        <td>{row._id.name}</td>
                        <td>{row._id.routingVersionId}</td>
                        <td>{row.total}</td>
                        <td>{row.failed}</td>
                        <td>{row.review}</td>
                        <td>
                          {(row.failed / row.total).toLocaleString("fa-IR", {
                            style: "percent",
                            maximumFractionDigits: 1,
                          })}
                        </td>
                      </tr>
                    );
                  if ("attempt" in row)
                    return (
                      <tr key={row.id}>
                        <td>
                          <Link to={"/assembly/visits/" + row.visitId}>
                            {row.unitCode}
                          </Link>
                        </td>
                        <td>{row.stationName}</td>
                        <td>{row.testName}</td>
                        <td>
                          {outcomes[row.outcome]} · {row.answer}
                        </td>
                        <td>
                          {row.attempt} / {row.revision}
                        </td>
                        <td>{new Date(row.at).toLocaleString("fa-IR")}</td>
                      </tr>
                    );
                  return (
                    <tr key={row.id}>
                      <td>
                        <Link to={"/assembly/visits/" + row.id}>
                          {row.unitCode}
                        </Link>
                      </td>
                      <td>{row.modelName}</td>
                      <td>{row.lineName}</td>
                      <td>{row.stationName}</td>
                      <td>
                        {row.completedAt
                          ? new Date(row.completedAt).toLocaleString("fa-IR")
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination page={page} count={record.data.count} onPage={setPage} />
        </section>
      )}
    </div>
  );
}
