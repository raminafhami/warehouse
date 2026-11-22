import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { BarcodeLabel } from "../components/BarcodeLabel.jsx";
import { useResource } from "../components/useResource.js";
import { errorMessage } from "../request/identity.js";
import { useCommand } from "../request/useCommand.js";

/** @typedef {{id:string,testId:string,testName:string,visitId:string,unitCode:string,reason:string,status:keyof typeof caseStatus,version:number,decisions?:{action:string,reason:string,at:string}[]}} Defect */
/** @typedef {import('../basket/api.js').Part} Part */
export const caseStatus = {
  technical: "در انتظار تصمیم فنی",
  escalated: "ارجاع بالاتر",
  replacing: "در انتظار تعویض",
  rework: "در انتظار دوباره‌کاری",
  retest: "در انتظار تست مجدد",
  resolved: "رفع‌شده",
  retest_failed: "تست مجدد ناموفق",
};
/** @param {{visitId:string,result:import('../assembly/api.js').Result,parts:Part[],disabled:boolean}} props */
export function OpenDefect({ visitId, result, parts, disabled }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const command = useCommand(),
    navigate = useNavigate();
  const technical = result.outcome === "review";
  return (
    <form
      className="toolbar"
      onSubmit={async (event) => {
        event.preventDefault();
        setError("");
        setBusy(true);
        const form = new FormData(event.currentTarget);
        try {
          /** @type {Defect} */
          const row = await command(
            "/defects/visits/" + visitId + (technical ? "/refer" : "/declare"),
            {
              testId: result.testId,
              resultId: result.id,
              reason: form.get("reason"),
              ...(technical ? {} : { partId: form.get("partId") }),
            },
          );
          navigate("/defects/cases/" + row.id);
        } catch (error) {
          setError(errorMessage(error));
        } finally {
          setBusy(false);
        }
      }}
    >
      {!technical && <PartSelect parts={parts} />}
      <label>
        شرح خرابی یا ارجاع <input name="reason" required maxLength={500} />
      </label>
      <button disabled={disabled || busy}>
        {technical ? "ارجاع به مسئول فنی" : "ثبت پروندهٔ خرابی"}
      </button>
      {error && <span role="alert">{error}</span>}
    </form>
  );
}

/** @param {{parts:Part[],required?:boolean}} props */
function PartSelect({ parts, required = true }) {
  return (
    <label>
      قطعهٔ نصب‌شده{" "}
      <select name="partId" required={required}>
        <option value="">انتخاب کنید</option>
        {parts.map((part) => (
          <option key={part.id} value={part.id}>
            {part.code} · {part.skuCode}
          </option>
        ))}
      </select>
    </label>
  );
}

/** @typedef {{case:Defect,requirements:string[],part:Part|null,replacement:Part|null,installed:Part[],stock:{id:string,cartonCode:string,line:string}[],access:{decide:boolean,label:boolean,install:boolean,rework:boolean,cancelLabel:boolean}}} Detail */
export function DefectDetailPage() {
  const { id } = useParams(),
    path = "/defects/cases/" + id;
  const [revision, reload] = useState(0),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [label, setLabel] = useState(false),
    [decision, setDecision] = useState("");
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
  const row = data.case,
    access = data.access;
  /** @param {string} action @param {import('react').FormEvent<HTMLFormElement>} event */
  async function save(action, event) {
    event.preventDefault();
    if (!data || busy || loading) return;
    const form = new FormData(event.currentTarget),
      values = Object.fromEntries(form);
    setBusy(true);
    setError("");
    try {
      await command(path + "/" + action, {
        version: data.case.version,
        ...values,
        ...(action === "rework"
          ? {
              checklist: data.requirements.map((_, index) =>
                form.has("check" + index),
              ),
            }
          : {}),
      });
      reload((value) => value + 1);
      if (action === "label") setLabel(true);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  const blocked = busy || loading;
  return (
    <div className="page-stack">
      <h1>پروندهٔ خرابی · {row.unitCode}</h1>
      <section className="panel panel-pad page-stack">
        <Link to={"/assembly/visits/" + row.visitId}>
          مراجعهٔ ایستگاه و تست مجدد
        </Link>
        <h2>
          {row.testName} · {caseStatus[row.status]}
        </h2>
        <p>{row.reason}</p>
        {data.part && (
          <p>
            قطعهٔ معیوب {data.part.code} · کارتن {data.part.cartonCode}
          </p>
        )}
        {data.replacement && (
          <p>
            قطعهٔ جایگزین {data.replacement.code} · کارتن{" "}
            {data.replacement.cartonCode}
          </p>
        )}
        {(error || loadError) && <p role="alert">{error || loadError}</p>}
        {(row.status === "technical" || row.status === "escalated") &&
          access.decide && (
            <form
              className="toolbar"
              onSubmit={(event) => void save("decide", event)}
            >
              <label>
                تصمیم فنی{" "}
                <select
                  name="decision"
                  value={decision}
                  onChange={(event) => setDecision(event.target.value)}
                  required
                >
                  <option value="">انتخاب کنید</option>
                  <option value="replace">تعویض قطعه</option>
                  <option value="rework">دوباره‌کاری در ایستگاه</option>
                  {row.status === "technical" && (
                    <option value="escalate">ارجاع بالاتر</option>
                  )}
                </select>
              </label>
              {decision === "replace" && <PartSelect parts={data.installed} />}
              <label>
                شرح تصمیم <input name="reason" required maxLength={500} />
              </label>
              <button disabled={blocked}>ثبت تصمیم</button>
            </form>
          )}
        {row.status === "replacing" && !data.replacement && access.label && (
          <form
            className="toolbar"
            onSubmit={(event) => void save("label", event)}
          >
            <label>
              کارتن مبدأ جایگزین{" "}
              <select name="custodyId" required>
                <option value="">انتخاب کنید</option>
                {data.stock.map((stock) => (
                  <option key={stock.id} value={stock.id}>
                    {stock.cartonCode} · {stock.line}
                  </option>
                ))}
              </select>
            </label>
            <button disabled={blocked || !data.stock.length}>
              رزرو جایگزین و چاپ برچسب
            </button>
            {!data.stock.length && <p>موجودی کافی در خط وجود ندارد.</p>}
          </form>
        )}
        {data.replacement && access.label && (
          <button type="button" onClick={() => setLabel(true)}>
            نمایش برچسب جایگزین
          </button>
        )}
        {row.status === "replacing" && data.replacement && access.install && (
          <form
            className="toolbar"
            onSubmit={(event) => void save("install", event)}
          >
            <label>
              بارکد جایگزین <input name="code" required dir="ltr" />
            </label>
            <button disabled={blocked}>ثبت نصب جایگزین</button>
          </form>
        )}
        {row.status === "replacing" &&
          data.replacement &&
          access.cancelLabel && (
            <form
              className="toolbar"
              onSubmit={(event) => void save("cancelLabel", event)}
            >
              <label>
                علت ابطال <input name="reason" required maxLength={500} />
              </label>
              <button disabled={blocked}>ابطال برچسب و آزادسازی رزرو</button>
            </form>
          )}
        {row.status === "rework" && access.rework && (
          <form
            className="page-stack"
            onSubmit={(event) => void save("rework", event)}
          >
            {data.requirements.map((item, index) => (
              <label key={index}>
                <input name={"check" + index} type="checkbox" required /> {item}
              </label>
            ))}
            <label>
              شناسهٔ گوشی <input name="code" required dir="ltr" />
            </label>
            <label>
              شرح دوباره‌کاری <input name="reason" required maxLength={500} />
            </label>
            <button disabled={blocked}>ارسال به تست مجدد</button>
          </form>
        )}
        {row.decisions?.map((event, index) => (
          <p key={index}>
            {event.action === "retest"
              ? "نتیجهٔ تست مجدد در مراجعه ثبت شد."
              : event.reason}{" "}
            · {new Date(event.at).toLocaleString("fa-IR")}
          </p>
        ))}
      </section>
      {label && data.replacement && (
        <BarcodeLabel
          title="برچسب قطعهٔ جایگزین"
          code={data.replacement.code}
          src={"/api/v1" + path + "/label"}
          onClose={() => setLabel(false)}
        />
      )}
    </div>
  );
}
