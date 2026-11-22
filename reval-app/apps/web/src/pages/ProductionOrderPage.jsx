import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Pagination } from "../components/Pagination.jsx";
import { useResource } from "../components/useResource.js";
import { hamtaLabels, unitLabels } from "../imei/api.js";
import { ImeiDialog } from "../imei/Dialog.jsx";
import { errorMessage } from "../request/identity.js";
import { useCommand } from "../request/useCommand.js";

/** @typedef {import("../imei/api.js").Unit} Unit */
const empty = /** @type {import("../imei/api.js").OrderDetail|null} */ (null);
const labels = {
  release: "آزادسازی IMEI",
  void: "ابطال IMEI چاپ‌شده",
  error: "ثبت خطای IMEI",
  replace: "تخصیص IMEI جایگزین",
};

export function ProductionOrderPage() {
  const { id } = useParams();
  const [page, setPage] = useState(0);
  const [rev, update] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [action, setAction] = useState(
    /** @type {{key:keyof typeof labels,unit:Unit}|null} */ (null),
  );
  const [history, setHistory] = useState(/** @type {Unit|null} */ (null));
  const resource = useResource(
    "/imei/orders/" + id + "?page=" + page,
    empty,
    rev,
  );
  const command = useCommand();
  const data = resource.data;
  async function allocate() {
    setBusy(true);
    setError("");
    try {
      await command("/imei/orders/" + id + "/units", {});
      setPage(0);
      update((value) => value + 1);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <header className="page-header">
        <h1>
          دستور تولید
          {data && (
            <>
              {" "}
              <bdi>{data.order.code}</bdi>
            </>
          )}
        </h1>
        <div className="toolbar">
          <Link to="/imei?tab=orders">دستورهای تولید</Link>
          {data?.access.allocate && (
            <button
              className="primary"
              disabled={
                busy ||
                resource.loading ||
                data.order.count ===
                  data.order.allocated + data.order.replacementDue
              }
              onClick={() => void allocate()}
            >
              تخصیص IMEI به گوشی
            </button>
          )}
        </div>
      </header>
      {(error || resource.error) && (
        <p role="alert">{error || resource.error}</p>
      )}
      {resource.loading && <p role="status">در حال دریافت…</p>}
      {data && (
        <>
          <section className="panel panel-pad">
            <p>
              {data.order.modelName} · {data.order.colorName} ·{" "}
              {data.order.lineName}
            </p>
            <p>
              {data.order.allocated.toLocaleString("fa")} از{" "}
              {data.order.count.toLocaleString("fa")} گوشی تخصیص یافته
              {data.order.replacementDue > 0 && (
                <>
                  {" "}
                  · {data.order.replacementDue.toLocaleString("fa")} در انتظار
                  جایگزین
                </>
              )}
            </p>
            <p>
              نسخهٔ BOM {data.order.bomRevision.toLocaleString("fa")} · نسخهٔ مسیر
              تولید {data.order.routingRevision.toLocaleString("fa")}
            </p>
          </section>
          <section className="panel">
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>گوشی</th>
                    <th>IMEI1</th>
                    <th>IMEI2</th>
                    <th>وضعیت</th>
                    <th>عملیات</th>
                  </tr>
                </thead>
                <tbody>
                  {data.data.map((unit) => (
                    <tr key={unit.id}>
                      <td dir="ltr">{unit.code}</td>
                      <td dir="ltr">{unit.numbers[0]}</td>
                      <td dir="ltr">{unit.numbers[1] ?? "—"}</td>
                      <td>
                        {unit.hamtaStatus
                          ? hamtaLabels[unit.hamtaStatus]
                          : unitLabels[unit.state]}
                        {unit.imeiError && <p>{unit.imeiError}</p>}
                      </td>
                      <td>
                        <div className="toolbar">
                          <button onClick={() => setHistory(unit)}>
                            سوابق
                          </button>
                          {unit.state === "allocated" &&
                            (!unit.hamtaStatus ||
                              unit.hamtaStatus === "pending") && (
                              <>
                                {!unit.hamtaStatus && data.access.error && (
                                  <button
                                    onClick={() =>
                                      setAction({ key: "error", unit })
                                    }
                                  >
                                    {labels.error}
                                  </button>
                                )}
                                {!unit.printedAt && data.access.release && (
                                  <button
                                    onClick={() =>
                                      setAction({ key: "release", unit })
                                    }
                                  >
                                    {labels.release}
                                  </button>
                                )}
                                {unit.printedAt && data.access.void && (
                                  <button
                                    onClick={() =>
                                      setAction({ key: "void", unit })
                                    }
                                  >
                                    {labels.void}
                                  </button>
                                )}
                              </>
                            )}
                          {unit.state === "void" && data.access.allocate && (
                            <button
                              onClick={() =>
                                setAction({ key: "replace", unit })
                              }
                            >
                              {labels.replace}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!data.count && (
              <p className="panel-pad">هنوز گوشی تخصیص نیافته است.</p>
            )}
            <Pagination page={page} count={data.count} onPage={setPage} />
          </section>
        </>
      )}
      {action && (
        <UnitAction
          operation={action}
          close={() => setAction(null)}
          updated={() => {
            setAction(null);
            update((value) => value + 1);
          }}
        />
      )}
      {history && <UnitHistory unit={history} close={() => setHistory(null)} />}
    </>
  );
}

/** @param {{operation:{key:keyof typeof labels,unit:Unit},close:()=>void,updated:()=>void}} props */
function UnitAction({ operation, close, updated }) {
  const command = useCommand();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { key, unit } = operation;
  /** @param {import("react").FormEvent<HTMLFormElement>} event */
  async function save(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await command("/imei/units/" + unit.id + "/" + key, {
        version: unit.version,
        reason: form.get("reason") ?? undefined,
      });
      updated();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ImeiDialog title={labels[key]} onClose={close} busy={busy}>
      <form onSubmit={save}>
        <p>
          <bdi>{unit.code}</bdi> · <bdi>{unit.numbers.join(" / ")}</bdi>
        </p>
        {key !== "replace" && (
          <label>
            علت
            <textarea name="reason" required maxLength={500} />
          </label>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="toolbar">
          <button className="primary" disabled={busy}>
            ثبت
          </button>
          <button type="button" onClick={close} disabled={busy}>
            انصراف
          </button>
        </div>
      </form>
    </ImeiDialog>
  );
}

const historyLabels = /** @type {Record<string,string>} */ ({
  "unit.allocate": "تخصیص IMEI",
  "unit.replace": "تخصیص جایگزین",
  "unit.released": "آزادسازی IMEI",
  "unit.void": "ابطال IMEI",
  "unit.error": "ثبت خطای IMEI",
  "unit.printed": "چاپ برچسب",
  "unit.final-qc": "تأیید QC نهایی",
  "hamta.submit": "ثبت نتیجهٔ اولیه",
  "hamta.retry": "ثبت تلاش مجدد",
  "hamta.reconcile": "تطبیق نتیجه",
  "hamta.evidence": "پیوست شاهد همتا",
  "hamta.official-correction": "ارجاع اصلاحیهٔ رسمی",
});

/** @param {{unit:Unit,close:()=>void}} props */
function UnitHistory({ unit, close }) {
  const [page, setPage] = useState(0);
  const initial =
    /** @type {{data:import("../imei/api.js").History[],count:number}} */ ({
      data: [],
      count: 0,
    });
  const resource = useResource(
    "/imei/units/" + unit.id + "/history?page=" + page,
    initial,
    0,
  );
  return (
    <ImeiDialog title="سوابق IMEI گوشی" onClose={close}>
      {resource.error && <p role="alert">{resource.error}</p>}
      {resource.loading ? (
        <p role="status">در حال دریافت…</p>
      ) : (
        !resource.data.count && <p>سابقه‌ای پیدا نشد.</p>
      )}
      <ul>
        {resource.data.data.map((row) => (
          <li key={row.id}>
            <strong>{historyLabels[row.action] ?? row.action}</strong> ·{" "}
            {new Date(row.at).toLocaleString("fa-IR")}
            {Array.isArray(row.detail.numbers) && (
              <div dir="ltr">{row.detail.numbers.join(" / ")}</div>
            )}
            {[
              "hamtaStatus",
              "reason",
              "hamtaReason",
              "reference",
              "trackingCode",
              "hamtaEvidence",
              "name",
            ].map((key) => {
              const value = row.detail[key];
              if (typeof value !== "string" || !value) return null;
              const display =
                key === "hamtaStatus"
                  ? Object.entries(hamtaLabels).find(
                      ([status]) => status === value,
                    )?.[1]
                  : value;
              return <div key={key}>{display}</div>;
            })}
          </li>
        ))}
      </ul>
      <Pagination page={page} count={resource.data.count} onPage={setPage} />
      <button onClick={close}>بستن</button>
    </ImeiDialog>
  );
}
