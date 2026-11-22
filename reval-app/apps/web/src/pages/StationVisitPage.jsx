import { caseStatus, OpenDefect } from "./DefectActions.jsx";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { outcomes, stages } from "../assembly/api.js";
import { partStatus } from "../basket/api.js";
import { useResource } from "../components/useResource.js";
import { errorMessage } from "../request/identity.js";
import { useCommand } from "../request/useCommand.js";

/** @param {{test:import('../assembly/api.js').Test,prior?:import('../assembly/api.js').Result,retest:boolean,correct:boolean,busy:boolean,save:(action:string,body:object)=>Promise<boolean>}} props */
function TestForm({ test, prior, retest, correct, busy, save }) {
  const [editing, setEditing] = useState(false);
  const [answer, setAnswer] = useState("");
  const [outcome, setOutcome] = useState("");
  const [reason, setReason] = useState("");
  return (
    <form
      className="panel panel-pad"
      onSubmit={async (event) => {
        event.preventDefault();
        const action = editing ? "correct" : "test";
        const change = editing ? { replacesId: prior?.id, reason } : {};
        if (
          await save(action, { testId: test.id, answer, outcome, ...change })
        ) {
          setEditing(false);
          setAnswer("");
          setOutcome("");
          setReason("");
        }
      }}
    >
      <h3>{test.name}</h3>
      {prior && (
        <p>
          {outcomes[prior.outcome]} · {prior.answer} · تلاش {prior.attempt}،
          نسخه {prior.revision}
        </p>
      )}
      {prior && correct && (
        <button
          type="button"
          onClick={() => {
            setEditing(!editing);
            setAnswer(prior.answer);
            setOutcome(prior.outcome);
          }}
        >
          {editing ? "لغو اصلاح" : "اصلاح نتیجه"}
        </button>
      )}
      {(editing || retest) && (
        <div className="toolbar">
          <label>
            پاسخ{" "}
            <select
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              required
            >
              <option value="">انتخاب پاسخ</option>
              {test.results.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <label>
            نتیجه{" "}
            <select
              value={outcome}
              onChange={(event) => setOutcome(event.target.value)}
              required
            >
              <option value="">انتخاب نتیجه</option>
              {Object.entries(outcomes).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {editing && (
            <label>
              علت اصلاح{" "}
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={500}
                required
              />
            </label>
          )}
          <button disabled={busy}>
            {editing ? "ثبت اصلاح" : prior ? "ثبت تلاش مجدد" : "ثبت نتیجه"}
          </button>
        </div>
      )}
    </form>
  );
}

/** @param {{selectedId?:string,onUpdated?:()=>void}} props */
export function StationVisitPage({ selectedId, onUpdated }) {
  const { id: routeId } = useParams();
  const id = selectedId ?? routeId;
  const [revision, reload] = useState(0);
  const record = useResource(
    "/assembly/visits/" + id,
    /** @type {import('../assembly/api.js').VisitDetail|null} */ (null),
    revision,
  );
  const [part, setPart] = useState("");
  const [phone, setPhone] = useState("");
  const [checks, setChecks] = useState(
    /** @type {Record<number,boolean>} */ ({}),
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const command = useCommand();
  const data = record.data;
  /** @param {string} action @param {object} body */
  async function save(action, body) {
    if (!data || busy || record.loading) return false;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      /** @type {{nextStation?:string|null}} */
      const result = await command("/assembly/visits/" + id + "/" + action, {
        version: data.visit.version,
        ...body,
      });
      if (action === "transfer")
        setNotice(
          result.nextStation
            ? "گوشی به صف ایستگاه «" + result.nextStation + "» منتقل شد."
            : "گوشی در انتظار کنترل کیفیت نهایی است.",
        );
      reload((value) => value + 1);
      onUpdated?.();
      return true;
    } catch (error) {
      setError(errorMessage(error));
      return false;
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return (
      <p role={record.error ? "alert" : "status"}>
        {record.error || "در حال دریافت اطلاعات ایستگاه…"}
      </p>
    );
  const { visit, settings, access } = data;
  const locked = busy || record.loading;
  return (
    <div className="page-stack">
      <div className="toolbar">
        {!selectedId && <Link to="/assembly">خط مونتاژ</Link>}
        <h1>{visit.stationName}</h1>
        <button onClick={() => reload(revision + 1)}>به‌روزرسانی</button>
      </div>
      <section className="panel panel-pad">
        <h2>
          {visit.unitCode} · {visit.modelName}
        </h2>
        <p>
          {visit.lineName} · {stages[visit.status]}
        </p>
        <label>
          پیشرفت مسیر{" "}
          <progress
            max={data.routeLength}
            value={visit.index + (visit.status === "transferred" ? 1 : 0)}
          />{" "}
          {visit.index + (visit.status === "transferred" ? 1 : 0)} از{" "}
          {data.routeLength}
        </label>
        {settings.operation && <p>{settings.operation}</p>}
        <p>
          ورود {new Date(visit.entryAt).toLocaleString("fa-IR")}
          {visit.completedAt &&
            " · تکمیل " + new Date(visit.completedAt).toLocaleString("fa-IR")}
          {visit.exitAt &&
            " · خروج " + new Date(visit.exitAt).toLocaleString("fa-IR")}
        </p>
        {(error || record.error) && <p role="alert">{error || record.error}</p>}
        {notice && <p role="status">{notice}</p>}
      </section>
      <section className="panel panel-pad">
        <h2>قطعات این ایستگاه</h2>
        {data.needs.length > 0 && (
          <p>
            {data.needs
              .map((need) => need.skuCode + " × " + need.quantity)
              .join(" · ")}
          </p>
        )}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>برچسب</th>
                <th>کد قطعه</th>
                <th>تعداد</th>
                <th>وضعیت</th>
              </tr>
            </thead>
            <tbody>
              {data.parts.map((row) => (
                <tr key={row.id}>
                  <td>{row.code}</td>
                  <td>{row.skuCode}</td>
                  <td>{row.quantity}</td>
                  <td>{partStatus[row.state]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {visit.status === "installing" && access.install && (
          <form
            className="toolbar"
            onSubmit={async (event) => {
              event.preventDefault();
              if (await save("install", { code: part })) setPart("");
            }}
          >
            <label>
              بارکد قطعه{" "}
              <input
                dir="ltr"
                required
                value={part}
                onChange={(event) => setPart(event.target.value)}
              />
            </label>
            <button disabled={locked}>ثبت نصب</button>
          </form>
        )}
      </section>
      {visit.status === "installing" && access.complete && (
        <form
          className="panel panel-pad page-stack"
          onSubmit={(event) => {
            event.preventDefault();
            void save("complete", {
              code: phone,
              checklist: settings.requirements.map(
                (_, index) => checks[index] === true,
              ),
            });
          }}
        >
          <h2>تکمیل مونتاژ</h2>
          {settings.requirements.map((item, index) => (
            <label key={index}>
              <input
                type="checkbox"
                checked={checks[index] === true}
                onChange={(event) =>
                  setChecks({ ...checks, [index]: event.target.checked })
                }
              />{" "}
              {item}
            </label>
          ))}
          <label>
            اسکن دوبارهٔ شناسهٔ گوشی{" "}
            <input
              dir="ltr"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              required
            />
          </label>
          <button disabled={locked}>ارسال به کنترل کیفیت مرحله‌ای</button>
        </form>
      )}
      {visit.status !== "installing" && (
        <section className="panel panel-pad page-stack">
          <h2>کنترل کیفیت مرحله‌ای</h2>
          {!settings.tests.length && (
            <p>برای این ایستگاه تستی تعریف نشده است.</p>
          )}
          {settings.tests.map((test) => {
            const prior = data.results.find((row) => row.testId === test.id);
            const defect = data.defects.find((row) => row.testId === test.id);
            const mayOpen =
              !defect ||
              defect.status === "resolved" ||
              defect.status === "retest_failed";
            return (
              <div className="page-stack" key={test.id}>
                <TestForm
                  test={test}
                  prior={prior}
                  busy={locked}
                  retest={
                    visit.status === "testing" &&
                    access.test &&
                    (defect?.status === "retest" ||
                      ((!defect || defect.status === "resolved") &&
                        (!prior ||
                          (prior.outcome !== "pass" &&
                            prior.attempt <= settings.maxRetests))))
                  }
                  correct={
                    visit.status === "testing" &&
                    access.correct &&
                    (!defect || defect.status === "resolved")
                  }
                  save={save}
                />
                {defect && (
                  <Link to={"/defects/cases/" + defect.id}>
                    پروندهٔ خرابی · {caseStatus[defect.status]}
                  </Link>
                )}
                {visit.status === "testing" &&
                  mayOpen &&
                  prior &&
                  ((prior.outcome === "fail" && data.canOpenDefect) ||
                    (prior.outcome === "review" && access.test)) && (
                    <OpenDefect
                      visitId={visit.id}
                      result={prior}
                      disabled={locked}
                      parts={data.parts.filter(
                        (part) => part.state === "installed",
                      )}
                    />
                  )}
              </div>
            );
          })}
          {visit.status === "testing" && access.transfer && (
            <button disabled={locked} onClick={() => void save("transfer", {})}>
              تأیید و انتقال گوشی
            </button>
          )}
          {data.results.length > 0 && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>تست</th>
                    <th>نتیجه</th>
                    <th>تلاش / نسخه</th>
                    <th>زمان</th>
                    <th>علت اصلاح</th>
                  </tr>
                </thead>
                <tbody>
                  {data.results.map((row) => (
                    <tr key={row.id}>
                      <td>{row.testName}</td>
                      <td>
                        {outcomes[row.outcome]} · {row.answer}
                      </td>
                      <td>
                        {row.attempt} / {row.revision}
                      </td>
                      <td>{new Date(row.at).toLocaleString("fa-IR")}</td>
                      <td>{row.reason ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      <section className="panel panel-pad">
        <h2>تاریخچهٔ مراحل گوشی</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>ایستگاه</th>
                <th>اپراتور</th>
                <th>ورود</th>
                <th>خروج</th>
                <th>وضعیت</th>
              </tr>
            </thead>
            <tbody>
              {data.history.map((row) => (
                <tr key={row.id}>
                  <td>{row.stationName}</td>
                  <td>{row.enteredName ?? "—"}</td>
                  <td>{new Date(row.entryAt).toLocaleString("fa-IR")}</td>
                  <td>
                    {row.exitAt
                      ? new Date(row.exitAt).toLocaleString("fa-IR")
                      : "—"}
                  </td>
                  <td>{stages[row.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
