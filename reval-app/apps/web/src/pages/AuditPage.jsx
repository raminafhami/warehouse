import { openPrintPreview } from "../components/PrintPreview.jsx";
import { useState } from "react";
import { Pagination } from "../components/Pagination.jsx";
import { StatusStrip } from "../components/StatusStrip.jsx";
import { useResource } from "../components/useResource.js";
import { errorMessage, request } from "../request/identity.js";

const empty =
  /** @type {{ data: import("../request/identity.js").Audit[], count: number }} */ ({
    data: [],
    count: 0,
  });
const moduleNames = /** @type {Record<string, string>} */ ({
  auth: "ورود و نشست",
  master: "اطلاعات پایه",
  shipments: "ورود محموله",
  inventory: "موجودی انبار",
  handover: "تحویل به تولید",
  imei: "IMEI و برنامه تولید",
  basket: "آماده‌سازی سبد",
  assembly: "خط مونتاژ",
  stageQc: "کیفیت مرحله‌ای",
  finalQc: "QC نهایی و بسته‌بندی",
  defects: "مرجوعی‌ها",
  finished: "انبار محصول",
  reports: "گزارشات",
  trace: "رهگیری",
  users: "کاربران و دسترسی",
  audit: "سوابق ممیزی",
});
const actionNames = /** @type {Record<string, string>} */ ({
  login: "ورود",
  logout: "خروج",
  "password.change": "تغییر رمز",
  "user.view": "مشاهدهٔ کاربر",
  "user.create": "ایجاد کاربر",
  "user.update": "ویرایش کاربر",
  "user.status": "تغییر وضعیت کاربر",
  "role.create": "ایجاد نقش",
  "role.update": "تغییر مجوز نقش",
  "audit.export": "خروجی ممیزی",
});
const clock = new Intl.DateTimeFormat("fa-IR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Asia/Tehran",
});

/** @param {{ exportAllowed: boolean }} props */
export function AuditPage({ exportAllowed }) {
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [module, setModule] = useState("");
  const [result, setResult] = useState("");
  const [printError, setPrintError] = useState("");
  const query = new URLSearchParams({
    page: String(page),
    q: search,
    module,
    result,
  });
  const events = useResource("/audit?" + query, empty, 0);
  const successes = useResource("/audit?size=1&result=success", empty, 0);
  const rejections = useResource("/audit?size=1&result=rejected", empty, 0);

  async function printAudit() {
    setPrintError("");
    try {
      await request("/audit/export?" + query);
      openPrintPreview();
    } catch (error) {
      setPrintError(errorMessage(error));
    }
  }

  return (
    <>
      <header className="page-header">
        <h1>تاریخچه فعالیت‌ها و گزارش ممیزی</h1>
        {exportAllowed && (
          <button
            disabled={events.loading || Boolean(events.error)}
            onClick={() => void printAudit()}
          >
            PDF
          </button>
        )}
      </header>
      <StatusStrip
        items={[
          {
            label: "نتایج فیلترشده",
            value: events.loading ? undefined : events.data.count,
          },
          {
            label: "عملیات موفق",
            value:
              successes.loading || successes.error
                ? undefined
                : successes.data.count,
          },
          {
            label: "عملیات ردشده",
            value:
              rejections.loading || rejections.error
                ? undefined
                : rejections.data.count,
          },
          {
            label: "ردیف‌های این صفحه",
            value: events.loading ? undefined : events.data.data.length,
          },
        ]}
      />
      <section className="panel">
        <div className="toolbar panel-pad">
          <label>
            نتیجه
            <select
              value={result}
              onChange={(e) => {
                setResult(e.target.value);
                setPage(0);
              }}
            >
              <option value="">همه</option>
              <option value="success">موفق</option>
              <option value="rejected">ردشده</option>
            </select>
          </label>
          <label>
            بخش
            <select
              value={module}
              onChange={(e) => {
                setModule(e.target.value);
                setPage(0);
              }}
            >
              <option value="">همهٔ بخش‌ها</option>
              {Object.entries(moduleNames).map(([key, name]) => (
                <option key={key} value={key}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            رکورد، کاربر یا عملیات
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
            />
          </label>
        </div>
        {(events.error || printError) && (
          <p className="panel-pad" role="alert">
            {events.error || printError}
          </p>
        )}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>زمان</th>
                <th>کاربر</th>
                <th>بخش</th>
                <th>عملیات</th>
                <th>رکورد مرتبط</th>
                <th>تغییرات</th>
                <th>نتیجه</th>
              </tr>
            </thead>
            <tbody>
              {events.data.data.map((item) => (
                <tr key={item._id}>
                  <td>{clock.format(new Date(item.at))}</td>
                  <td>{item.actorName ?? "—"}</td>
                  <td>{moduleNames[item.module] ?? item.module}</td>
                  <td>{actionNames[item.action] ?? item.action}</td>
                  <td>
                    <small dir="ltr">{item.entityId ?? "—"}</small>
                  </td>
                  <td>
                    {item.before || item.after ? (
                      <details>
                        <summary>مشاهده</summary>
                        <pre dir="ltr">
                          {JSON.stringify(
                            { before: item.before, after: item.after },
                            null,
                            2,
                          )}
                        </pre>
                      </details>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <span
                      className={
                        item.result === "success" ? "badge active" : "badge"
                      }
                    >
                      {item.result === "success" ? "موفق" : "ردشده"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {events.loading ? (
          <p className="panel-pad" role="status">
            در حال دریافت…
          </p>
        ) : (
          !events.data.count && <p className="panel-pad">سابقه‌ای پیدا نشد.</p>
        )}
        <Pagination page={page} count={events.data.count} onPage={setPage} />
      </section>
    </>
  );
}
