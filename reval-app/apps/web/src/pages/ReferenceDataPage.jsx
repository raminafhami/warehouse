import { useSearchParams } from "react-router-dom";
import { Pagination } from "../components/Pagination.jsx";
import { useResource } from "../components/useResource.js";

const names = {
  users: "کاربران",
  roles: "نقش‌ها",
  lines: "خطوط",
  suppliers: "تأمین‌کنندگان",
  partTypes: "انواع قطعه",
  skus: "کدهای کالا",
  models: "مدل‌ها",
  tests: "آزمون‌ها",
  stations: "ایستگاه‌ها",
  warehouses: "انبارها",
  locations: "موقعیت‌ها",
  zones: "ناحیه‌ها",
  shipments: "محموله‌ها",
  pallets: "پالت‌ها",
  cartons: "کارتن‌های ورودی",
  movements: "گردش کالا",
  adjustments: "اصلاح موجودی",
  requests: "درخواست‌ها",
  deliveries: "حواله‌ها",
  imeis: "مخزن IMEI",
  orders: "دستورهای تولید",
  phones: "گوشی‌ها",
  parts: "قطعات",
  baskets: "سبدها",
  visits: "مراحل مونتاژ",
  results: "نتایج آزمون",
  defects: "خرابی‌ها",
  replacements: "تعویض‌ها",
  returns: "مرجوعی‌ها",
  dealers: "فروشندگان",
  distOrders: "سفارش‌های توزیع",
  masterCartons: "کارتن‌های محصول",
  audit: "سوابق ممیزی",
};

export function ReferenceDataPage() {
  const [params, setParams] = useSearchParams();
  const selected = params.get("section") ?? "shipments";
  const section = Object.hasOwn(names, selected) ? selected : "shipments";
  const sectionName = names[/** @type {keyof typeof names} */ (section)];
  const page = Math.max(0, Number(params.get("page")) || 0);
  const summary = useResource(
    "/demo/reference/summary",
    /** @type {{counts:Record<string,number>}|null} */ (null),
    0,
  );
  const result = useResource(
    summary.data ? "/demo/reference/" + section + "?page=" + page : null,
    /** @type {{ count:number, rows:Record<string,unknown>[] }} */ ({
      count: 0,
      rows: [],
    }),
    0,
  );
  return (
    <div className="page-stack">
      <h1>داده‌های نسخه مرجع</h1>
      <p>
        رکوردهای این نما از نمونه رسمی REVAL هستند و برای بررسی به‌صورت
        فقط‌خواندنی نمایش داده می‌شوند.
      </p>
      {(summary.error || result.error) && (
        <p role="alert">{summary.error || result.error}</p>
      )}
      {summary.loading && <p role="status">در حال دریافت فهرست داده مرجع…</p>}
      {!summary.loading && !summary.error && !summary.data && (
        <p>داده مرجع هنوز بارگذاری نشده است.</p>
      )}
      {summary.data && (
        <section className="panel panel-pad page-stack">
          <label>
            بخش داده
            <select
              value={section}
              onChange={(event) => setParams({ section: event.target.value })}
            >
              {Object.entries(names)
                .filter(([key]) => key in (summary.data?.counts ?? {}))
                .map(([key, label]) => (
                  <option key={key} value={key}>
                    {label} ·{" "}
                    {summary.data?.counts[key].toLocaleString("fa-IR")}
                  </option>
                ))}
            </select>
          </label>
          {result.loading ? (
            <p role="status">در حال دریافت…</p>
          ) : (
            <ul className="record-list">
              {result.data.rows.map((row, index) => (
                <li key={index}>
                  <details>
                    <summary>
                      {String(
                        row.id ?? row.code ?? row.imei ?? index + page * 12 + 1,
                      )}{" "}
                      ·{" "}
                      {String(
                        row.name ?? row.title ?? row.status ?? sectionName,
                      )}
                    </summary>
                    <pre
                      style={{ maxWidth: "100%", overflowWrap: "anywhere" }}
                      dir="ltr"
                    >
                      {JSON.stringify(row, null, 2)}
                    </pre>
                  </details>
                </li>
              ))}
            </ul>
          )}
          <Pagination
            page={page}
            count={result.data.count}
            onPage={(next) => setParams({ section, page: String(next) })}
          />
        </section>
      )}
    </div>
  );
}
