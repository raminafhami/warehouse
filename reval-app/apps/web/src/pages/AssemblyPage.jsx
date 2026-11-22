import { openPrintPreview } from "../components/PrintPreview.jsx";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { stages } from "../assembly/api.js";
import { Pagination } from "../components/Pagination.jsx";
import { useResource } from "../components/useResource.js";
import { errorMessage } from "../request/identity.js";
import { useCommand } from "../request/useCommand.js";
import { StationVisitPage } from "./StationVisitPage.jsx";

const empty = /** @type {import('../assembly/api.js').Queue} */ ({
  items: [],
  models: [],
  count: 0,
  access: { scan: false, pdf: false },
});
/** @param {{receive:boolean}} props */
export function AssemblyPage({ receive }) {
  const options = useResource(
    "/assembly/options",
    /** @type {import('../assembly/api.js').Station[]} */ ([]),
    0,
  );
  const [selection, setSelection] = useSearchParams();
  const lineId = selection.get("line") ?? "";
  const stations = options.data.filter(
    (row) => !lineId || row.lineId === lineId,
  );
  const stationId = selection.get("station") ?? stations[0]?.id ?? "";
  const [modelId, setModel] = useState("");
  const [page, setPage] = useState(0);
  const [revision, reload] = useState(0);
  const [scan, setScan] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const command = useCommand();
  const station = stations.find((row) => row.id === stationId);
  const params = new URLSearchParams({
    stationId,
    page: String(page),
    ...(modelId ? { modelId } : {}),
  });
  const queue = useResource(
    station ? "/assembly/queue?" + params : "/assembly/queue",
    empty,
    revision,
  );
  const incomingParams = new URLSearchParams({
    mode: "incoming",
    status: "handed_over",
    size: "1",
    ...(lineId ? { lineId } : {}),
  });
  const incoming = useResource(
    receive ? "/basket?" + incomingParams : null,
    /** @type {{data:{id:string,code:string}[],count:number}} */ ({
      data: [],
      count: 0,
    }),
    revision,
  );
  const selectedVisit =
    selection.get("visit") ??
    queue.data.items.find((row) => row.visitId)?.visitId;
  const effectiveModelId =
    modelId || (queue.data.models.length === 1 ? queue.data.models[0].id : "");

  /** @param {string} id */
  function selectStation(id) {
    setSelection(
      { ...(lineId ? { line: lineId } : {}), ...(id ? { station: id } : {}) },
      { replace: true },
    );
    setModel("");
    setScan("");
    setError("");
    setPage(0);
  }

  /** @param {import('react').FormEvent<HTMLFormElement>} event */
  async function enter(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      /** @type {{visit:import('../assembly/api.js').Visit}} */
      const result = await command("/assembly/entry", {
        stationId,
        modelId: effectiveModelId,
        code: scan,
      });
      setSelection({
        station: stationId,
        ...(lineId ? { line: lineId } : {}),
        visit: result.visit.id,
      });
      setScan("");
      reload((value) => value + 1);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-stack">
      <header className="page-header">
        <h1>خط مونتاژ{station ? " · " + station.lineName : ""}</h1>
        <div className="toolbar">
          {queue.data.models.length > 0 && (
            <div className="chips dashboard-lines" aria-label="مدل گوشی">
              {queue.data.models.map((model) => (
                <button
                  type="button"
                  key={model.id}
                  aria-pressed={effectiveModelId === model.id}
                  onClick={() => {
                    setModel(model.id === modelId ? "" : model.id);
                    setPage(0);
                  }}
                >
                  {model.name}
                </button>
              ))}
            </div>
          )}
          {queue.data.access?.pdf && (
            <button onClick={openPrintPreview}>PDF</button>
          )}
        </div>
      </header>
      {receive && (
        <div className="assembly-banner">
          <strong>
            {incoming.data.count > 0
              ? incoming.data.count.toLocaleString("fa-IR") +
                " سبد تحویل مونتاژ شده و منتظر تأیید دریافت است"
              : "دریافت سبد در مونتاژ"}
          </strong>
          <Link
            className="badge active"
            to={
              "/basket?" +
              new URLSearchParams({
                mode: "incoming",
                ...(lineId ? { line: lineId } : {}),
                ...(incoming.data.data[0]
                  ? { basket: incoming.data.data[0].id }
                  : {}),
              })
            }
          >
            {incoming.data.data[0]?.code ?? "مشاهده صف دریافت"}
          </Link>
        </div>
      )}
      {station && (
        <div
          className="station-tabs assembly-steps"
          aria-label="ایستگاه‌های این خط"
        >
          {stations
            .filter((row) => row.lineId === station.lineId)
            .map((row) => (
              <button
                type="button"
                key={row.id}
                aria-pressed={row.id === stationId}
                onClick={() => selectStation(row.id)}
              >
                <small>
                  <bdi>{row.code}</bdi>
                </small>
                {row.name}
              </button>
            ))}
        </div>
      )}
      <div className="split-detail">
        <section className="panel">
          <div className="panel-heading">
            <h2>صف ایستگاه</h2>
          </div>
          <div className="toolbar panel-pad">
            <label>
              خط و ایستگاه{" "}
              <select
                value={stationId}
                onChange={(event) => selectStation(event.target.value)}
              >
                <option value="">انتخاب ایستگاه</option>
                {stations.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.lineName} · {row.name}
                  </option>
                ))}
              </select>
            </label>
            {station && (
              <button onClick={() => reload(revision + 1)}>
                به‌روزرسانی صف
              </button>
            )}
          </div>
          {station && (
            <>
              <h2 className="panel-pad">
                {station.lineName} · {station.name}
              </h2>
              {queue.data.access?.scan && (
                <form className="toolbar panel-pad" onSubmit={enter}>
                  <label>
                    بارکد شناسهٔ گوشی{" "}
                    <input
                      value={scan}
                      onChange={(event) => setScan(event.target.value)}
                      dir="ltr"
                      required
                    />
                  </label>
                  <button
                    className="primary"
                    disabled={busy || !effectiveModelId}
                  >
                    ثبت ورود
                  </button>
                  {!effectiveModelId && (
                    <small>مدل گوشی را برای ثبت ورود انتخاب کنید.</small>
                  )}
                </form>
              )}
              <ul className="record-list">
                {queue.data.items.map((row) => {
                  const entry = (
                    <>
                      <bdi>{row.unitCode}</bdi>
                      <span className="badge">{stages[row.status]}</span>
                      <small>
                        {row.modelName} · <bdi>{row.orderCode}</bdi>
                      </small>
                    </>
                  );
                  return (
                    <li key={row.id}>
                      {row.visitId ? (
                        <Link
                          to={
                            "?" +
                            new URLSearchParams({
                              ...(lineId ? { line: lineId } : {}),
                              station: stationId,
                              visit: row.visitId,
                            })
                          }
                          aria-current={
                            row.visitId === selectedVisit ? "true" : undefined
                          }
                        >
                          {entry}
                        </Link>
                      ) : (
                        <div className="record-static">{entry}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
              {!queue.loading && !queue.data.count && (
                <p className="panel-pad">گوشی در این صف نیست.</p>
              )}
              <Pagination
                page={page}
                count={queue.data.count ?? 0}
                onPage={setPage}
              />
            </>
          )}
          {(options.error || (station && queue.error) || error) && (
            <p className="panel-pad" role="alert">
              {options.error || queue.error || error}
            </p>
          )}
        </section>
        {selectedVisit ? (
          <StationVisitPage
            key={selectedVisit}
            selectedId={selectedVisit}
            onUpdated={() => reload((value) => value + 1)}
          />
        ) : (
          <section className="panel detail-placeholder">
            {queue.loading
              ? "در حال دریافت صف…"
              : "برای شروع عملیات، گوشی را در ایستگاه اسکن کنید."}
          </section>
        )}
      </div>
    </div>
  );
}
