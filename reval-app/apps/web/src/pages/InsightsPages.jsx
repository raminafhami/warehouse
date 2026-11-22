import { openPrintPreview } from "../components/PrintPreview.jsx";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Pagination } from "../components/Pagination.jsx";
import { useResource } from "../components/useResource.js";
import { accountLabels } from "../inventory/api.js";
import { ChartBars, ChartCard } from "./DashboardPage.jsx";

const time = new Intl.DateTimeFormat("fa-IR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Asia/Tehran",
});
const chartDate = new Intl.DateTimeFormat("fa-IR", {
  month: "numeric",
  day: "numeric",
  timeZone: "Asia/Tehran",
});
const reportLabels = {
  shipments: "محموله‌های ورودی",
  pallets: "پالت‌ها",
  material: "کارتن‌های مواد و بچ",
  balances: "موجودی و جانمایی مواد",
  ledger: "گردش و تطبیق دفتر",
  handover: "تحویل به تولید",
  baskets: "سبدهای تولید",
  assembly: "مراجعه‌های مونتاژ",
  stage: "تست مرحله‌ای",
  final: "کنترل کیفیت نهایی",
  defects: "پرونده‌های خرابی",
  returns: "مرجوعی تأمین‌کننده",
  finished: "انبار محصول",
};
const traceLabels = {
  units: "گوشی و IMEI",
  parts: "قطعهٔ نصب‌شده یا معیوب",
  material: "کارتن مواد یا بچ",
  shipments: "محموله",
  pallets: "پالت",
  baskets: "سبد تولید",
  finished: "کارتن محصول",
  suppliers: "تأمین‌کننده",
};
const statuses = {
  approved: "تأییدشده",
  receiving: "در حال دریافت",
  received: "دریافت‌شده",
  discrepancy: "مغایرت",
  testing: "در آزمون",
  installing: "در حال مونتاژ",
  transferred: "منتقل‌شده",
  open: "باز",
  placed: "جانمایی‌شده",
  closed: "بسته",
  pass: "قبول",
  fail: "رد",
  review: "نیازمند بررسی",
  used: "مصرف‌شده",
  installed: "نصب‌شده",
  allocated: "تخصیص‌یافته",
  defective: "معیوب",
  defect_store: "قرنطینهٔ معیوبی",
  supplier_return: "تحویل تأمین‌کننده",
  resolved: "رفع‌شده",
};
/** @param {string} value */
function localCell(value) {
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))
    return time.format(new Date(value));
  return (
    statuses[/** @type {keyof typeof statuses} */ (value)] ??
    accountLabels[/** @type {keyof typeof accountLabels} */ (value)] ??
    value
  );
}
/** @typedef {{id:string,name:string}} Option */
/** @param {{lines:Option[],value:string,onChange:(value:string)=>void}} props */
function Lines({ lines, value, onChange }) {
  return (
    <label>
      خط تولید{" "}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">همهٔ خطوط مجاز</option>
        {lines.map((row) => (
          <option key={row.id} value={row.id}>
            {row.name}
          </option>
        ))}
      </select>
    </label>
  );
}
/** @param {{columns:string[],rows:import('react').ReactNode[][]}} props */
function Table({ columns, rows }) {
  if (!rows.length) return <p>رکوردی پیدا نشد.</p>;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {columns.map((label) => (
              <th key={label}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((value, i) => (
                <td key={i}>{value ?? "—"}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** @typedef {{lines:Option[],columns:{key:string,label:string}[],items:string[][],count:number,dated:boolean,quantity:string|null,canPrint:boolean,canExport:boolean,snapshot:{sku:string,account:string,current:string,expected:string,difference:string,balanced:boolean}[]|null}} Report */
export function ReportsPage() {
  const [kind, setKind] = useState("shipments"),
    [lineId, setLine] = useState(""),
    [period, setPeriod] = useState("all"),
    [query, setQuery] = useState(""),
    [page, setPage] = useState(0);
  const params = new URLSearchParams({ kind, period, lineId, q: query });
  const result = useResource(
    "/reports?" + params + "&page=" + page,
    /** @type {Report} */ ({
      lines: [],
      columns: [],
      items: [],
      count: 0,
      dated: true,
      quantity: null,
      canPrint: false,
      canExport: false,
      snapshot: null,
    }),
    0,
  );
  const overview = useResource(
    "/reports/overview?" + new URLSearchParams({ period, lineId, q: query }),
    /** @type {Record<"production"|"balances"|"defects"|"suppliers",{label:string,value:number}[]>} */ ({
      production: [],
      balances: [],
      defects: [],
      suppliers: [],
    }),
    0,
  );
  const data = result.data,
    title = reportLabels[/** @type {keyof typeof reportLabels} */ (kind)];
  const periods = {
    1: "امروز",
    7: "۷ روز اخیر",
    30: "۳۰ روز اخیر",
    all: "کل دوره",
  };
  return (
    <div className="page-stack insights-print">
      <header className="page-header">
        <h1>گزارشات و خروجی PDF</h1>
        <div className="toolbar">
          <Lines
            lines={data.lines}
            value={lineId}
            onChange={(value) => {
              setLine(value);
              setPage(0);
            }}
          />
          <label>
            بازهٔ تاریخ{" "}
            <select
              value={period}
              onChange={(event) => {
                setPeriod(event.target.value);
                setPage(0);
              }}
            >
              {Object.entries(periods).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            جست‌وجوی گزارش{" "}
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(0);
              }}
              maxLength={100}
            />
          </label>
          {data.canPrint && (
            <button onClick={() => openPrintPreview()}>PDF صفحهٔ گزارش</button>
          )}
          {data.canExport && (
            <a href={"/api/v1/reports?" + params + "&export=csv"} download>
              CSV همهٔ نتایج فیلترشده
            </a>
          )}
        </div>
      </header>
      {overview.error && <p role="alert">{overview.error}</p>}
      <div className="dashboard-charts">
        <ChartCard
          title="تولید روزانه"
          subtitle={
            period === "all" ? "گوشی تکمیل‌شده · ۳۰ روز اخیر" : "گوشی تکمیل‌شده"
          }
        >
          <ChartBars
            vertical
            rows={overview.data.production.map((point) => ({
              ...point,
              label: chartDate.format(new Date(point.label + "T12:00:00Z")),
            }))}
          />
        </ChartCard>
        <ChartCard title="موجودی قطعات" subtitle="مانده فعلی بر اساس کد کالا">
          <ChartBars rows={overview.data.balances} />
        </ChartCard>
        <ChartCard
          title="خرابی‌ها"
          subtitle={
            period === "all" ? "به تفکیک وضعیت · ۳۰ روز اخیر" : "به تفکیک وضعیت"
          }
        >
          <ChartBars
            rows={overview.data.defects.map((point) => ({
              ...point,
              label: localCell(point.label),
            }))}
          />
        </ChartCard>
        <ChartCard
          title="ورود قطعه به تفکیک تأمین‌کننده"
          subtitle="تعداد قطعه دریافتی"
        >
          <ChartBars rows={overview.data.suppliers} />
        </ChartCard>
      </div>
      <div className="split-detail">
        <nav className="panel" aria-label="فهرست گزارشات">
          <div className="panel-heading">
            <h2>گزارشات</h2>
          </div>
          <ul className="record-list">
            {Object.entries(reportLabels).map(([key, label]) => (
              <li key={key}>
                <button
                  type="button"
                  aria-pressed={key === kind}
                  onClick={() => {
                    setKind(key);
                    setPage(0);
                  }}
                >
                  {label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="page-stack">
          <section className="panel panel-pad page-stack">
            <h2>{title}</h2>
            <p className="insights-context">
              {data.lines.find((row) => row.id === lineId)?.name ??
                (lineId ? "خط انتخاب‌شده" : "همهٔ خطوط مجاز")}{" "}
              ·{" "}
              {data.dated
                ? periods[/** @type {keyof typeof periods} */ (period)]
                : "ماندهٔ کنونی"}
              {query && " · جست‌وجو " + query} · صفحهٔ{" "}
              {(page + 1).toLocaleString("fa-IR")} ·{" "}
              {data.count.toLocaleString("fa-IR")} ردیف
            </p>
            {data.quantity !== null && (
              <p>مجموع مقدار در ردیف‌های فیلترشده {data.quantity}</p>
            )}
            {result.error && <p role="alert">{result.error}</p>}
            {result.loading ? (
              <p role="status">در حال دریافت گزارش…</p>
            ) : (
              <Table
                columns={data.columns.map((row) => row.label)}
                rows={data.items.map((row) =>
                  row.map((value) => localCell(value) || "—"),
                )}
              />
            )}
            <Pagination page={page} count={data.count} onPage={setPage} />
          </section>
          {data.snapshot && (
            <section className="panel panel-pad">
              <h2>تطبیق ماندهٔ حساب‌های انبار با دفتر گردش</h2>
              <Table
                columns={[
                  "کالا",
                  "حساب",
                  "ماندهٔ ثبت‌شده",
                  "خالص دفتر",
                  "اختلاف",
                ]}
                rows={data.snapshot.map((row) => [
                  row.sku,
                  localCell(row.account),
                  row.current,
                  row.expected,
                  row.difference,
                ])}
              />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

const traceShortcuts = [
  {
    mode: "stored-replacement",
    kind: "units",
    label: "گوشی انبارشده با قطعهٔ تعویضی",
  },
  { mode: "in-line", kind: "units", label: "گوشی در خط" },
  { mode: "defective", kind: "parts", label: "قطعهٔ معیوب" },
  { mode: "material-carton", kind: "material", label: "کارتن مواد" },
  { mode: "material-lot", kind: "material", label: "بچ قطعه" },
  { mode: "finished-carton", kind: "finished", label: "کارتن محصول" },
];

/** @typedef {{id:string,code?:string,title?:string,status?:string,lot?:string,numbers?:string[]}} Hit */
/** @param {{demo?:boolean}} props */
export function TracePage({ demo }) {
  const [location, setLocation] = useSearchParams();
  const kind = location.get("kind") ?? "all",
    query = location.get("q") ?? "",
    mode = location.get("mode") ?? "",
    partTypeId = location.get("partTypeId") ?? "",
    page = Number(location.get("page") ?? 0);
  const options = useResource(
    "/trace/options",
    /** @type {{id:string,code:string,name:string}[]} */ ([]),
    0,
  );
  const result = useResource(
    "/trace?" +
      new URLSearchParams({
        q: query,
        kind,
        mode,
        partTypeId,
        page: String(page),
      }),
    /** @type {{kind:string,items:Hit[],count:number}[]} */ ([]),
    0,
  );
  return (
    <div className="page-stack">
      <h1>رهگیری یکپارچه</h1>
      <div className="panel panel-pad page-stack">
        <div className="chips" aria-label="فیلترهای رهگیری">
          <button
            aria-pressed={!mode}
            onClick={() => setLocation(query ? { q: query } : {})}
          >
            جست‌وجوی عمومی
          </button>
          {traceShortcuts.map((shortcut) => (
            <button
              key={shortcut.mode}
              aria-pressed={mode === shortcut.mode}
              onClick={() =>
                setLocation({
                  kind: shortcut.kind,
                  mode: shortcut.mode,
                  ...(query ? { q: query } : {}),
                  ...(shortcut.kind === "material" && partTypeId
                    ? { partTypeId }
                    : {}),
                })
              }
            >
              {shortcut.label}
            </button>
          ))}
        </div>
        <form
          className="toolbar trace-search"
          key={[query, kind, mode, partTypeId].join("|")}
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const chosen = mode ? kind : String(data.get("kind"));
            setLocation({
              q: String(data.get("q")).trim(),
              kind: chosen,
              ...(mode ? { mode } : {}),
              ...(chosen === "material" && data.get("partTypeId")
                ? { partTypeId: String(data.get("partTypeId")) }
                : {}),
            });
          }}
        >
          <label>
            شناسه یا نام{" "}
            <input
              name="q"
              defaultValue={query}
              maxLength={100}
              required={!mode && !partTypeId}
              placeholder="IMEI، قطعه، کارتن، پالت، محموله یا بچ"
            />
          </label>
          <label>
            نوع رکورد{" "}
            <select name="kind" defaultValue={kind} disabled={Boolean(mode)}>
              <option value="all">همهٔ انواع</option>
              {Object.entries(traceLabels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {kind === "material" && !options.loading && (
            <label>
              نوع قطعه{" "}
              <select name="partTypeId" defaultValue={partTypeId}>
                <option value="">همهٔ نوع‌ها</option>
                {options.data.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name} · {type.code}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button disabled={kind === "material" && options.loading}>
            جست‌وجو
          </button>
          {demo && (
            <button
              type="button"
              onClick={() =>
                setLocation({ q: "CTN-1405-8101", kind: "material" })
              }
            >
              اسکن آزمایشی
            </button>
          )}
        </form>
      </div>
      {!query && !mode && !partTypeId && (
        <section className="panel panel-pad detail-placeholder">
          یک شناسه را اسکن یا وارد کنید
        </section>
      )}
      {kind === "material" && options.error && (
        <p role="alert">{options.error}</p>
      )}
      {result.error && <p role="alert">{result.error}</p>}
      {(query || mode || partTypeId) &&
        !result.loading &&
        !result.data.some((group) => group.count) && (
          <p>شناسه‌ای در محدودهٔ دسترسی پیدا نشد.</p>
        )}
      {result.data
        .filter((group) => group.count)
        .map((group) => (
          <section key={group.kind} className="panel panel-pad">
            <h2>
              {
                traceLabels[
                  /** @type {keyof typeof traceLabels} */ (group.kind)
                ]
              }
            </h2>
            <Table
              columns={["شناسه", "شرح", "وضعیت"]}
              rows={group.items.map((row) => [
                <Link key={row.id} to={"/trace/" + group.kind + "/" + row.id}>
                  {row.code ?? row.title}
                </Link>,
                [row.title, row.lot, row.numbers?.join(" / ")]
                  .filter(Boolean)
                  .join(" · "),
                row.status ? localCell(row.status) : "—",
              ])}
            />
            <Pagination
              page={page}
              count={group.count}
              onPage={(value) =>
                setLocation({
                  q: query,
                  kind: group.kind,
                  mode,
                  partTypeId,
                  page: String(value),
                })
              }
            />
          </section>
        ))}
    </div>
  );
}

const sections = {
  units: [
    "گوشی‌ها",
    {
      code: "شناسه",
      numbers: "IMEI",
      orderCode: "دستور",
      modelName: "مدل",
      lineName: "خط",
      qcPassedAt: "قبولی نهایی",
      hamtaStatus: "همتا",
    },
  ],
  parts: [
    "قطعات و پیوند تعویض",
    {
      code: "برچسب",
      skuCode: "کالا",
      cartonCode: "کارتن مبدأ",
      state: "وضعیت",
      replacesPartId: "قطعهٔ قبلی",
      installedAt: "زمان نصب",
      installedBy: "نصب‌کننده",
    },
  ],
  finished: [
    "کارتن محصول",
    {
      code: "کارتن",
      status: "وضعیت",
      locationName: "موقعیت",
      closedAt: "بستن",
      placedAt: "جانمایی",
    },
  ],
  baskets: [
    "سبد تولید",
    {
      code: "سبد",
      unitCode: "گوشی",
      status: "وضعیت",
      handedAt: "تحویل",
      receivedAt: "دریافت",
    },
  ],
  material: [
    "کارتن‌های مواد",
    {
      code: "کارتن",
      skuCode: "کالا",
      lot: "بچ",
      quantity: "مقدار",
      state: "وضعیت",
      at: "زمان",
    },
  ],
  pallets: ["پالت", { code: "پالت", at: "زمان" }],
  shipments: [
    "محموله و تأمین‌کننده",
    {
      code: "محموله",
      supplierName: "تأمین‌کننده",
      waybillNumber: "بارنامه",
      createdAt: "زمان",
      status: "وضعیت",
    },
  ],
  requests: [
    "درخواست تحویل",
    { code: "درخواست", status: "وضعیت", actorId: "کاربر", at: "زمان" },
  ],
  deliveries: [
    "حواله‌های خط",
    {
      code: "حواله",
      status: "وضعیت",
      issuerId: "تحویل‌دهنده",
      receiverId: "گیرنده",
      at: "زمان",
    },
  ],
  visits: [
    "مراجعه‌های ایستگاه",
    {
      unitCode: "گوشی",
      stationName: "ایستگاه",
      enteredName: "اپراتور",
      entryAt: "ورود",
      exitAt: "خروج",
      status: "وضعیت",
    },
  ],
  results: [
    "آزمون‌های مرحله‌ای",
    {
      unitCode: "گوشی",
      testName: "تست",
      outcome: "نتیجه",
      attempt: "تلاش",
      revision: "نسخه",
      actorId: "کاربر",
      at: "زمان",
    },
  ],
  finalChecks: [
    "آزمون‌های نهایی",
    {
      unitId: "گوشی",
      item: "تست",
      round: "تلاش",
      outcome: "نتیجه",
      actorId: "کاربر",
      at: "زمان",
    },
  ],
  finalRejections: [
    "ارجاع‌های نهایی",
    { unitId: "گوشی", reason: "علت", actorId: "کاربر", at: "زمان" },
  ],
  defects: [
    "پروندهٔ خرابی",
    {
      unitCode: "گوشی",
      testName: "تست",
      status: "وضعیت",
      reason: "علت",
      actorId: "کاربر",
      at: "زمان",
    },
  ],
  returns: [
    "مرجوعی تأمین‌کننده",
    { code: "سند", supplierName: "تأمین‌کننده", status: "وضعیت", at: "زمان" },
  ],
  history: [
    "تاریخچهٔ شناسه و تولید",
    { action: "عملیات", actorId: "کاربر", at: "زمان" },
  ],
  ledger: [
    "دفتر گردش",
    {
      documentType: "سند",
      from: "مبدأ",
      to: "مقصد",
      quantity: "مقدار",
      actorId: "کاربر",
      at: "زمان",
    },
  ],
};
/** @typedef {{actors:Record<string,string>}&Partial<Record<keyof typeof sections,Record<string,unknown>[]>>} TraceDetail */
export function TraceDetailPage() {
  const { kind, id } = useParams();
  const resource = useResource(
    "/trace/" + kind + "/" + id,
    /** @type {TraceDetail|null} */ (null),
    0,
  );
  const data = resource.data;
  if (!data)
    return (
      <p role={resource.error ? "alert" : "status"}>
        {resource.error || "در حال دریافت زنجیره…"}
      </p>
    );
  return (
    <div className="page-stack">
      <h1>زنجیرهٔ رهگیری</h1>
      <Link to="/trace">جست‌وجوی دیگر</Link>
      {Object.entries(sections).map(([key, [title, columns]]) => {
        const rows = data[/** @type {keyof typeof sections} */ (key)] ?? [];
        if (!rows.length || typeof columns !== "object") return null;
        return (
          <section className="panel panel-pad" key={key}>
            <h2>{String(title)}</h2>
            <Table
              columns={Object.values(columns)}
              rows={rows.slice(0, 50).map((row) =>
                Object.keys(columns).map((field) => {
                  const value = row[field];
                  if (field === "replacesPartId" && typeof value === "string")
                    return (
                      <Link to={"/trace/parts/" + value}>
                        {data.parts
                          ?.find((part) => part.id === value)
                          ?.code?.toString() ?? value}
                      </Link>
                    );
                  if (
                    field === "code" &&
                    Object.hasOwn(traceLabels, key) &&
                    typeof row.id === "string" &&
                    row.id !== id
                  )
                    return (
                      <Link to={"/trace/" + key + "/" + row.id}>
                        {String(value)}
                      </Link>
                    );
                  if (
                    typeof value === "string" &&
                    (field.endsWith("Id") || field.endsWith("By"))
                  )
                    return (
                      data.actors[value] ??
                      data.units
                        ?.find((unit) => unit.id === value)
                        ?.code?.toString() ??
                      value
                    );
                  return value == null
                    ? "—"
                    : localCell(
                        Array.isArray(value)
                          ? value.join(" / ")
                          : String(value),
                      );
                }),
              )}
            />
            {rows.length > 50 && (
              <p>
                ۵۰ رکورد نمایش داده شد. برای بررسی جزئی‌تر شناسهٔ مرتبط را باز
                کنید.
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}
