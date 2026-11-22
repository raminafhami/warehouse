import { openPrintPreview } from "../components/PrintPreview.jsx";
import { useState } from "react";
import { Link } from "react-router-dom";
import productionImage from "../assets/login-production.webp";
import { Icon } from "../components/Icon.jsx";
import { basketStatus } from "../basket/api.js";
import { useResource } from "../components/useResource.js";
import "./DashboardPage.css";

const fa = new Intl.NumberFormat("fa-IR");
const date = new Intl.DateTimeFormat("fa-IR", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: "Asia/Tehran",
});
const shortDate = new Intl.DateTimeFormat("fa-IR", {
  month: "numeric",
  day: "numeric",
  timeZone: "Asia/Tehran",
});
const percent = new Intl.NumberFormat("fa-IR", {
  style: "percent",
  maximumFractionDigits: 1,
});
/** @typedef {{lines:{id:string,name:string}[],canPrint:boolean,actions:{waitingBaskets:number,openDefects:number,incomingIssues:number|null,readyForFinal:number},production:{_id:{day:string,line:string},count:number}[],quality:{_id:string,count:number,passed:number}[],stations:{_id:{line:string,station:string},count:number}[],defects:{_id:string,count:number}[],work:{_id:{line:string,status:string},count:number}[],packed?:number,receivedCartons?:number}} Dashboard */
/** @type {Dashboard} */
const empty = {
  lines: [],
  canPrint: false,
  production: [],
  quality: [],
  stations: [],
  defects: [],
  work: [],
  actions: {
    waitingBaskets: 0,
    openDefects: 0,
    incomingIssues: null,
    readyForFinal: 0,
  },
};
const colors = ["#f5a300", "#3473bf", "#3f9872", "#ad624a", "#7b69ac"];

/** @param {{title:string,subtitle?:string,children:import("react").ReactNode}} props */
export function ChartCard({ title, subtitle, children }) {
  return (
    <section className="panel dashboard-card">
      <header>
        <h2>{title}</h2>
        {subtitle && <small>{subtitle}</small>}
      </header>
      <div className="chart-body">{children}</div>
    </section>
  );
}

/** @param {{rows:{label:string,value:number,group?:string}[],ratio?:boolean,vertical?:boolean}} props */
export function ChartBars({ rows, ratio = false, vertical = false }) {
  if (!rows.length)
    return <p className="chart-empty">داده‌ای برای این بازه ثبت نشده است.</p>;
  const groups = [...new Set(rows.map((row) => row.group).filter(Boolean))];
  const max = ratio ? 1 : Math.max(1, ...rows.map((row) => row.value));
  return (
    <>
      <ul className={vertical ? "chart-bars vertical" : "chart-bars"}>
        {rows.map((row, index) => {
          const value = ratio
            ? percent.format(row.value)
            : fa.format(row.value);
          const color =
            colors[Math.max(0, groups.indexOf(row.group)) % colors.length];
          return (
            <li
              key={index}
              title={[row.label, row.group, value].filter(Boolean).join(" · ")}
            >
              <span>{row.label}</span>
              <div className="chart-track">
                <i
                  style={{
                    [vertical ? "height" : "width"]:
                      `${(row.value / max) * 100}%`,
                    backgroundColor: color,
                  }}
                />
              </div>
              <b>{value}</b>
            </li>
          );
        })}
      </ul>
      {groups.length > 1 && (
        <div className="toolbar chart-legend">
          {groups.map((group, index) => (
            <span key={group}>
              <i style={{ backgroundColor: colors[index % colors.length] }} />
              {group}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

/** @param {{profile:import("../request/identity.js").Profile}} props */
export function DashboardPage({ profile }) {
  const [lineId, setLineId] = useState("");
  const result = useResource(
    "/dashboard?" + new URLSearchParams({ lineId }),
    empty,
    0,
  );
  const data = result.data;
  const can = (/** @type {string} */ permission) =>
    profile.permissions.includes(permission);
  const stationTotal = data.stations.reduce(
    (total, row) => total + row.count,
    0,
  );
  const productionTotal = data.production.reduce(
    (total, row) => total + row.count,
    0,
  );
  const checkTotal = data.quality.reduce((total, row) => total + row.count, 0);
  const passedTotal = data.quality.reduce(
    (total, row) => total + row.passed,
    0,
  );
  const stages = /** @type {const} */ ([
    [
      "ورود و انبار مواد",
      "/inventory",
      "inventory:view",
      data.receivedCartons,
      14,
      40,
      "shipments",
      "کارتن دریافت‌شده",
    ],
    [
      "آماده‌سازی سبد",
      "/basket",
      "basket:view",
      data.work
        .filter(
          (row) =>
            row._id.status !== "received" && row._id.status !== "cancelled",
        )
        .reduce((sum, row) => sum + row.count, 0),
      33,
      48,
      "basket",
      "سبد در جریان",
    ],
    [
      "خط مونتاژ",
      "/assembly",
      "assembly:view",
      stationTotal,
      53,
      36,
      "assembly",
      "گوشی در ایستگاه",
    ],
    [
      "QC نهایی و بسته‌بندی",
      "/final-qc",
      "finalQc:view",
      data.actions.readyForFinal,
      72,
      52,
      "final-qc",
      "در صف تست نهایی",
    ],
    [
      "انبار محصول",
      "/finished",
      "finished:view",
      data.packed,
      87,
      38,
      "finished",
      "گوشی بسته‌بندی‌شده",
    ],
  ]);
  const kpis = /** @type {const} */ ([
    [
      "گوشی در خط تولید",
      stationTotal,
      fa.format(data.actions.readyForFinal) + " گوشی منتظر QC نهایی",
      "assembly",
      "assembly:view",
    ],
    [
      "تکمیل‌شده",
      productionTotal,
      "۱۴ روز اخیر · قبولی QC نهایی " +
        (checkTotal ? percent.format(passedTotal / checkTotal) : "—"),
      "final-qc",
      "finalQc:view",
    ],
    [
      "موجودی انبار محصول",
      data.packed,
      "گوشی بسته‌بندی‌شده",
      "finished",
      "finished:view",
    ],
    [
      "مردود و ارجاع فنی",
      data.actions.openDefects,
      "پرونده خرابی باز",
      "defects",
      "defects:view",
    ],
  ]);
  const alerts = /** @type {const} */ ([
    [
      "سبد در انتظار دریافت",
      "/basket?mode=incoming",
      "assembly:approve",
      data.actions.waitingBaskets,
    ],
    [
      "گوشی در انتظار کیفیت نهایی",
      "/final-qc",
      "finalQc:view",
      data.actions.readyForFinal,
    ],
    ["پرونده خرابی باز", "/defects", "defects:view", data.actions.openDefects],
    [
      "محموله با مغایرت",
      "/shipments",
      "shipments:view",
      data.actions.incomingIssues ?? 0,
    ],
  ]).filter((row) => row[3] > 0 && can(row[2]));

  return (
    <div className="page-stack insights-print">
      <header className="page-header">
        <div>
          <h1>داشبورد</h1>
          <p className="insights-context">
            {profile.name} · {profile.roleName} · {date.format(new Date())}
          </p>
        </div>
        <div className="toolbar">
          <div className="chips dashboard-lines" aria-label="خط تولید">
            {[{ id: "", name: "همه خطوط" }, ...data.lines].map((line) => (
              <button
                key={line.id}
                aria-pressed={line.id === lineId}
                onClick={() => setLineId(line.id)}
              >
                {line.name}
              </button>
            ))}
          </div>
          {data.canPrint && (
            <button onClick={() => openPrintPreview()}>PDF</button>
          )}
        </div>
      </header>
      {result.loading && <p role="status">در حال دریافت داشبورد…</p>}
      {result.error && <p role="alert">{result.error}</p>}
      <section className="hero">
        <header className="hero-head">
          <div className="hero-sum">
            <span>
              <b>{fa.format(productionTotal)}</b> تکمیل‌شده در ۱۴ روز اخیر
            </span>
            <span>
              <b>
                {checkTotal ? percent.format(passedTotal / checkTotal) : "—"}
              </b>{" "}
              قبولی QC نهایی
            </span>
          </div>
        </header>
        <div className="hero-scroll">
          <div className="hero-stage">
            <img src={productionImage} alt="" />
            {stages.map(
              ([label, to, permission, count, x, y]) =>
                can(permission) && (
                  <Link
                    key={to}
                    to={
                      to +
                      (lineId && (to === "/assembly" || to === "/basket")
                        ? "?" + new URLSearchParams({ line: lineId })
                        : "")
                    }
                    className="hotspot"
                    aria-label={label}
                    style={{ left: x + "%", top: y + "%" }}
                  >
                    <span className="hs-ring" />
                    <b className="hs-n">
                      {count === undefined ? "—" : fa.format(count)}
                    </b>
                    <span className="hs-tip">{label}</span>
                  </Link>
                ),
            )}
          </div>
        </div>
        <ol className="hero-steps">
          {stages.map(
            ([label, to, permission, count, , , icon, hint], index) => {
              const content = (
                <>
                  <span className="hst-ic">
                    <Icon name={icon} size={18} />
                  </span>
                  <span className="hst-t">
                    <small>مرحله {fa.format(index + 1)}</small>
                    <b>{label}</b>
                    <span>{hint}</span>
                  </span>
                  <strong className="hst-n">
                    {count === undefined ? "—" : fa.format(count)}
                  </strong>
                </>
              );
              return (
                <li key={to}>
                  {can(permission) ? (
                    <Link className="hero-step" to={to}>
                      {content}
                    </Link>
                  ) : (
                    <span className="hero-step off">{content}</span>
                  )}
                </li>
              );
            },
          )}
        </ol>
      </section>
      <div className="dashboard-kpis">
        {kpis.map(([label, count, note, icon, permission]) => {
          const content = (
            <>
              <div className="k-top">
                {label}
                <span className="k-ic">
                  <Icon name={icon} />
                </span>
              </div>
              <strong className="k-num">
                {count === undefined ? "—" : fa.format(count)}
              </strong>
              <span className="k-sub">{note}</span>
            </>
          );
          return can(permission) ? (
            <Link className="panel kpi" key={label} to={"/" + icon}>
              {content}
            </Link>
          ) : (
            <div className="panel kpi" key={label}>
              {content}
            </div>
          );
        })}
      </div>
      <div className="dashboard-charts">
        <ChartCard
          title="گوشی در هر ایستگاه"
          subtitle="به تفکیک خط تولید · همین حالا"
        >
          <ChartBars
            rows={data.stations.map((row) => ({
              label: row._id.station,
              group: row._id.line,
              value: row.count,
            }))}
          />
        </ChartCard>
        <ChartCard
          title="نیازمند اقدام"
          subtitle={
            fa.format(alerts.reduce((sum, row) => sum + row[3], 0)) + " مورد"
          }
        >
          {alerts.length ? (
            <ul className="dashboard-alerts">
              {alerts.map(([label, to, , count]) => (
                <li key={to}>
                  <Link to={to}>
                    {label}
                    <span className="badge">{fa.format(count)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="chart-empty">موردی برای پیگیری وجود ندارد.</p>
          )}
        </ChartCard>
        <ChartCard
          title="تولید روزانه به تفکیک خط"
          subtitle="گوشی تکمیل‌شده · ۱۴ روز اخیر"
        >
          <ChartBars
            vertical
            rows={data.production.map((row) => ({
              label: shortDate.format(new Date(row._id.day + "T12:00:00Z")),
              group: row._id.line,
              value: row.count,
            }))}
          />
        </ChartCard>
        <ChartCard
          title="نرخ قبولی QC نهایی"
          subtitle="درصد تست‌های قبول · ۱۴ روز اخیر"
        >
          <ChartBars
            vertical
            ratio
            rows={data.quality.map((row) => ({
              label: shortDate.format(new Date(row._id + "T12:00:00Z")),
              value: row.passed / row.count,
            }))}
          />
        </ChartCard>
        <ChartCard
          title="گوشی در جریان تولید هر خط"
          subtitle="سبدها به تفکیک وضعیت"
        >
          <ChartBars
            rows={data.work.map((row) => ({
              label: row._id.line,
              group:
                basketStatus[
                  /** @type {keyof typeof basketStatus} */ (row._id.status)
                ] ?? row._id.status,
              value: row.count,
            }))}
          />
        </ChartCard>
        <ChartCard
          title="خرابی‌ها به تفکیک قطعه"
          subtitle="پرونده‌های خرابی · ۳۰ روز اخیر"
        >
          <ChartBars
            rows={data.defects.map((row) => ({
              label: row._id,
              value: row.count,
            }))}
          />
        </ChartCard>
      </div>
    </div>
  );
}
