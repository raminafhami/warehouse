import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { BarcodeLabel } from "../components/BarcodeLabel.jsx";
import { Pagination } from "../components/Pagination.jsx";
import { StatusStrip } from "../components/StatusStrip.jsx";
import { useResource } from "../components/useResource.js";
import { errorMessage } from "../request/identity.js";
import { useCommand } from "../request/useCommand.js";

const statusLabels = {
  testing: "در صف آزمون",
  rework: "ارجاع به اصلاح",
  passed: "تأییدشده",
  packed: "بسته‌بندی‌شده",
};
/** @typedef {{id:string,code:string,modelName:string,colorName:string,lineName:string,status:keyof typeof statusLabels}} Phone */

export function FinalQualityPage() {
  const [query, setQuery] = useState(""),
    [modelId, setModel] = useState(""),
    [page, setPage] = useState(0);
  const [params, setParams] = useSearchParams();
  const [revision, reload] = useState(0);
  const view = params.get("view") === "packing" ? "packing" : "testing";
  const filters = new URLSearchParams({
    q: query,
    modelId,
    page: String(page),
    view,
  });
  const record = useResource(
    "/final-qc?" + filters,
    /** @type {{items:Phone[],models:{id:string,name:string}[],count:number,statuses:Partial<Record<keyof typeof statusLabels,number>>}} */ ({
      items: [],
      models: [],
      count: 0,
      statuses: {},
    }),
    revision,
  );
  const selectedId = params.get("phone") ?? record.data.items[0]?.id;
  return (
    <div className="page-stack">
      <h1>کنترل کیفیت نهایی و بسته‌بندی</h1>
      <StatusStrip
        items={Object.entries(statusLabels).map(([key, label]) => ({
          label,
          value: record.loading
            ? undefined
            : (record.data.statuses?.[
                /** @type {keyof typeof statusLabels} */ (key)
              ] ?? 0),
        }))}
      />
      <div className="tabs">
        {
          /** @type {const} */ ([
            ["testing", "صف کنترل کیفیت نهایی"],
            ["packing", "بسته‌بندی و برچسب جعبه"],
          ]).map(([key, title]) => (
            <button
              key={key}
              aria-pressed={key === view}
              onClick={() => {
                setParams({ view: key });
                setPage(0);
              }}
            >
              {title}
            </button>
          ))
        }
      </div>
      <div className="split-detail">
        <section className="panel page-stack">
          <div className="panel-heading">
            <h2>
              {view === "testing"
                ? "گوشی‌های آماده آزمون"
                : "گوشی‌های تأییدشده"}
            </h2>
          </div>
          <div className="toolbar panel-pad">
            <label>
              جستجوی گوشی یا خط{" "}
              <input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(0);
                }}
              />
            </label>
            <label>
              مدل{" "}
              <select
                value={modelId}
                onChange={(event) => {
                  setModel(event.target.value);
                  setPage(0);
                }}
              >
                <option value="">همهٔ مدل‌ها</option>
                {record.data.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {record.error && <p role="alert">{record.error}</p>}
          {!record.loading && !record.data.count && (
            <p>گوشی در این صف پیدا نشد.</p>
          )}
          <ul className="record-list">
            {record.data.items.map((phone) => (
              <li key={phone.id}>
                <Link
                  to={"?" + new URLSearchParams({ view, phone: phone.id })}
                  aria-current={selectedId === phone.id ? "true" : undefined}
                >
                  <bdi>{phone.code}</bdi>
                  <span className="badge">{statusLabels[phone.status]}</span>
                  <small>
                    {phone.modelName} · {phone.colorName} · {phone.lineName}
                  </small>
                </Link>
              </li>
            ))}
          </ul>
          <Pagination page={page} count={record.data.count} onPage={setPage} />
        </section>
        {selectedId ? (
          <FinalQualityDetail
            key={selectedId}
            selectedId={selectedId}
            onUpdated={() => reload((value) => value + 1)}
          />
        ) : (
          <section className="panel detail-placeholder">
            {record.loading
              ? "در حال دریافت صف…"
              : "گوشی را از صف انتخاب کنید."}
          </section>
        )}
      </div>
    </div>
  );
}

/** @typedef {{unit:Omit<Phone,"status">&{numbers:string[]},record:{round:number,version:number,status:keyof typeof statusLabels,labelAt?:string,cartonId?:string}|null,checks:Record<string,string>,packing:string[],steps:{id:string,name:string}[],results:{id:string,round:number,item:string,outcome:"pass"|"fail",at:string}[],rejections:{id:string,round:number,stationId:string,reason:string}[],access:Record<"check"|"approve"|"reject"|"label"|"pack",boolean>}} Detail */

/** @param {{selectedId?:string,onUpdated?:()=>void}} props */
export function FinalQualityDetail({ selectedId, onUpdated }) {
  const { id: routeId } = useParams();
  const id = selectedId ?? routeId;
  const path = "/final-qc/" + id;
  const [revision, reload] = useState(0),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState(false);
  const command = useCommand();
  const {
    data,
    loading,
    error: loadError,
  } = useResource(path, /** @type {Detail|null} */ (null), revision);
  if (!data)
    return (
      <p role={loadError ? "alert" : "status"}>
        {loadError || "در حال دریافت پرونده…"}
      </p>
    );
  const { unit, record, access, checks, steps, results, rejections, packing } =
    data;
  const round = record?.round ?? 1,
    status = record?.status ?? "testing";
  const current = results.filter((row) => row.round === round),
    blocked = busy || loading;
  /** @param {string} action @param {object} values */
  async function save(action, values) {
    if (blocked) return;
    setBusy(true);
    setError("");
    try {
      await command(path + "/" + action, {
        version: record?.version ?? 0,
        ...values,
      });
      reload((value) => value + 1);
      onUpdated?.();
      if (action === "label") setPreview(true);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  /** @param {string} action @param {import("react").FormEvent<HTMLFormElement>} event */
  function form(action, event) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    void save(
      action,
      action === "pack"
        ? {
            scans: unit.numbers.map((_, index) => values.get("imei" + index)),
            checklist: packing.map((_, index) => values.has("check" + index)),
          }
        : Object.fromEntries(values),
    );
  }
  return (
    <div className="page-stack">
      <h1>کیفیت نهایی · {unit.code}</h1>
      {!selectedId && <Link to="/final-qc">صف کیفیت نهایی</Link>}
      <section className="panel panel-pad page-stack">
        <p>
          {unit.modelName} · {unit.colorName} · {unit.lineName} ·{" "}
          {statusLabels[status]}
        </p>
        {(error || loadError) && <p role="alert">{error || loadError}</p>}
        {status === "testing" && (
          <>
            <h2>چک‌لیست آزمون نهایی · تلاش {round}</h2>
            {Object.entries(checks).map(([item, label]) => {
              const test = current.find((row) => row.item === item);
              return (
                <div className="toolbar" key={item}>
                  <span>{label}</span>
                  {test ? (
                    <strong>{test.outcome === "pass" ? "قبول" : "رد"}</strong>
                  ) : access.check ? (
                    <>
                      <button
                        disabled={blocked}
                        onClick={() =>
                          void save("check", { item, outcome: "pass" })
                        }
                      >
                        قبول
                      </button>
                      <button
                        disabled={blocked}
                        onClick={() =>
                          void save("check", { item, outcome: "fail" })
                        }
                      >
                        رد
                      </button>
                    </>
                  ) : (
                    <span>در انتظار آزمون</span>
                  )}
                </div>
              );
            })}
            {access.reject && current.some((row) => row.outcome === "fail") && (
              <form
                className="toolbar"
                onSubmit={(event) => form("reject", event)}
              >
                <label>
                  ایستگاه اصلاح{" "}
                  <select name="stationId" required>
                    <option value="">انتخاب کنید</option>
                    {steps.map((step) => (
                      <option key={step.id} value={step.id}>
                        {step.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  علت مردودی <input name="reason" required maxLength={500} />
                </label>
                <button disabled={blocked}>ارجاع برای اصلاح</button>
              </form>
            )}
            {access.approve && (
              <form
                className="toolbar"
                onSubmit={(event) => form("approve", event)}
              >
                <label>
                  اسکن IMEI گوشی <input name="code" required dir="ltr" />
                </label>
                <button
                  disabled={
                    blocked ||
                    Object.keys(checks).length !==
                      current.filter((row) => row.outcome === "pass").length
                  }
                >
                  تأیید کیفیت نهایی
                </button>
              </form>
            )}
          </>
        )}
        {status === "rework" && (
          <p>
            گوشی در صف ایستگاه اصلاح است. پس از تأیید مرحله، تلاش تازه در کیفیت
            نهایی باز می‌شود.
          </p>
        )}
        {(status === "passed" || status === "packed") && access.label && (
          <button
            disabled={blocked}
            onClick={() =>
              record?.labelAt ? setPreview(true) : void save("label", {})
            }
          >
            {record?.labelAt
              ? "نمایش و چاپ مجدد برچسب جعبه"
              : "صدور و چاپ برچسب جعبه"}
          </button>
        )}
        {status === "passed" && access.pack && record?.labelAt && (
          <form
            className="page-stack"
            onSubmit={(event) => form("pack", event)}
          >
            <h2>تطبیق برچسب و بسته‌بندی</h2>
            {unit.numbers.map((_, index) => (
              <label key={index}>
                اسکن IMEI {index + 1} روی جعبه{" "}
                <input name={"imei" + index} required dir="ltr" />
              </label>
            ))}
            {packing.map((label, index) => (
              <label key={label}>
                <input type="checkbox" name={"check" + index} required />{" "}
                {label}
              </label>
            ))}
            <button disabled={blocked}>ثبت بسته‌بندی</button>
          </form>
        )}
        {!!rejections.length && (
          <section>
            <h2>سابقهٔ ارجاع</h2>
            {rejections.map((row) => (
              <p key={row.id}>
                تلاش {row.round} ·{" "}
                {steps.find((step) => step.id === row.stationId)?.name} ·{" "}
                {row.reason}
              </p>
            ))}
          </section>
        )}
        {results.some((row) => row.round !== round) && (
          <section>
            <h2>نتیجه‌های تلاش‌های قبلی</h2>
            {results
              .filter((row) => row.round !== round)
              .map((row) => (
                <p key={row.id}>
                  تلاش {row.round} · {checks[row.item]} ·{" "}
                  {row.outcome === "pass" ? "قبول" : "رد"}
                </p>
              ))}
          </section>
        )}
      </section>
      {preview && record?.labelAt && (
        <BarcodeLabel
          title="برچسب جعبه"
          code={unit.numbers[0]}
          src={"/api/v1" + path + "/label/1"}
          additional={unit.numbers.slice(1).map((code, index) => ({
            code,
            src: "/api/v1" + path + "/label/" + (index + 2),
          }))}
          onClose={() => setPreview(false)}
        />
      )}
    </div>
  );
}
