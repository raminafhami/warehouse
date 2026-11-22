import { openPrintPreview } from "../components/PrintPreview.jsx";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { basketStatus, partStatus } from "../basket/api.js";
import { PartLabelEditor, RemovePartEditor } from "../basket/PartEditors.jsx";
import { BarcodeLabel } from "../components/BarcodeLabel.jsx";
import { useResource } from "../components/useResource.js";
import { errorMessage, request } from "../request/identity.js";
import { useCommand } from "../request/useCommand.js";

const empty = /** @type {import("../basket/api.js").Detail|null} */ (null);
/** @typedef {import("../basket/api.js").Part} Part */
/** @typedef {import("../basket/api.js").Need} Need */

/** @param {{selectedId?:string,onUpdated?:()=>void}} props */
export function BasketDetailPage({ selectedId, onUpdated }) {
  const { id: routeId } = useParams();
  const id = selectedId ?? routeId;
  const [params] = useSearchParams();
  const [revision, refresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [imeiCode, setImeiCode] = useState("");
  const [partCode, setPartCode] = useState("");
  const [skuId, setSku] = useState("");
  const [labelEditor, setLabelEditor] = useState(
    /** @type {Need|null} */ (null),
  );
  const [removing, setRemoving] = useState(/** @type {Part|null} */ (null));
  const [preview, setPreview] = useState(
    /** @type {"imei"|Part|null} */ (null),
  );
  const path = "/basket/" + id;
  const resource = useResource(path, empty, revision);
  const command = useCommand();
  const update = () => {
    refresh((value) => value + 1);
    onUpdated?.();
  };
  const data = resource.data;
  /** @param {string} endpoint @param {Record<string,unknown>} [fields] */
  async function act(endpoint, fields = {}) {
    if (!data) return;
    setBusy(true);
    setError("");
    try {
      await command(path + endpoint, {
        version: data.basket.version,
        ...fields,
      });
      if (endpoint === "/imei/print") setPreview("imei");
      if (endpoint === "/imei/scan") setImeiCode("");
      if (endpoint === "/parts/scan") setPartCode("");
      update();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function print() {
    setError("");
    try {
      await request(path + "/export");
      openPrintPreview();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  const incoming = params.get("mode") === "incoming";
  const back = !selectedId && (
    <Link to={incoming ? "/basket?mode=incoming" : "/basket"}>
      {incoming ? "سبدهای مونتاژ" : "فهرست سبدها"}
    </Link>
  );
  if (!data)
    return (
      <>
        <header className="page-header">
          <h1>سبد تولید</h1>
          {back}
        </header>
        {resource.error ? (
          <p role="alert">{resource.error}</p>
        ) : (
          <p role="status">در حال دریافت…</p>
        )}
      </>
    );
  const { basket, unit, parts, coverage, access } = data;
  const preparing = basket.status === "preparing";
  const canConfirm =
    basket.status !== "cancelled" &&
    unit.state === "allocated" &&
    !unit.imeiError;
  const locked = busy || resource.loading;
  const testPart = parts.find(
    (part) => part.skuId === skuId && part.state === "printed",
  );
  const labelSrc = "/api/v1" + path + "/labels/";
  return (
    <>
      <header className="page-header">
        <h1>
          سبد <bdi>{basket.code}</bdi>
        </h1>
        <div className="toolbar">
          {back}
          {access.pdf && (
            <button disabled={locked} onClick={() => void print()}>
              PDF
            </button>
          )}
        </div>
      </header>
      {(error || resource.error) && (
        <p role="alert">{error || resource.error}</p>
      )}
      <section className="panel panel-pad dark-band">
        <h2>{basketStatus[basket.status]}</h2>
        <p>
          {basket.modelName} · {basket.colorName} · {basket.lineName}
        </p>
        <p>
          گوشی <bdi>{basket.unitCode}</bdi> · دستور{" "}
          <bdi>{basket.orderCode}</bdi> · نسخهٔ BOM{" "}
          {basket.bomRevision.toLocaleString("fa")}
        </p>
        {basket.handedAt && (
          <p>
            تحویل به مونتاژ {new Date(basket.handedAt).toLocaleString("fa-IR")}
          </p>
        )}
        {basket.receivedAt && (
          <p>
            دریافت در مونتاژ{" "}
            {new Date(basket.receivedAt).toLocaleString("fa-IR")}
          </p>
        )}
        <div className="toolbar">
          {preparing && access.approve && (
            <button
              className="primary"
              disabled={locked || !unit.confirmed}
              onClick={() => void act("/ready")}
            >
              تأیید تکمیل سبد
            </button>
          )}
          {basket.status === "ready" && access.transfer && (
            <button
              className="primary"
              disabled={locked || !unit.confirmed}
              onClick={() => void act("/handover")}
            >
              تحویل به مونتاژ
            </button>
          )}
          {basket.status === "handed_over" && access.receive && (
            <button
              className="primary"
              disabled={locked || !unit.confirmed}
              onClick={() => void act("/receive")}
            >
              تأیید دریافت در مونتاژ
            </button>
          )}
        </div>
      </section>
      <section className="panel panel-pad">
        <h2>شناسهٔ گوشی</h2>
        <ul>
          {unit.numbers.map((number, index) => (
            <li key={number}>
              IMEI{index + 1} <bdi>{number}</bdi>
            </li>
          ))}
        </ul>
        {unit.imeiError && <p role="alert">{unit.imeiError}</p>}
        <p>
          {unit.confirmed
            ? "با اسکن تأیید شد"
            : unit.state === "void"
              ? "در انتظار IMEI جایگزین"
              : unit.state === "released"
                ? "IMEI آزاد شده است"
                : unit.printed
                  ? "در انتظار اسکن برچسب گوشی"
                  : "در انتظار چاپ برچسب گوشی"}
        </p>
        <div className="toolbar">
          {canConfirm && access.create && (
            <button
              disabled={locked}
              onClick={() =>
                unit.printed ? setPreview("imei") : void act("/imei/print")
              }
            >
              {unit.printed ? "چاپ مجدد IMEI" : "چاپ برچسب IMEI"}
            </button>
          )}
          {canConfirm && access.scan && unit.printed && !unit.confirmed && (
            <form
              className="toolbar"
              onSubmit={(event) => {
                event.preventDefault();
                void act("/imei/scan", { code: imeiCode });
              }}
            >
              <label>
                اسکن IMEI
                <input
                  name="imeiCode"
                  dir="ltr"
                  required
                  maxLength={40}
                  value={imeiCode}
                  onChange={(event) => setImeiCode(event.target.value)}
                />
              </label>
              <button className="primary" disabled={locked}>
                تأیید اسکن IMEI
              </button>
              {access.demo && (
                <button
                  type="button"
                  onClick={() => setImeiCode(unit.numbers[0])}
                >
                  اسکن آزمایشی IMEI
                </button>
              )}
            </form>
          )}
        </div>
      </section>
      <section className="panel">
        <header className="panel-pad">
          <h2>اقلام BOM</h2>
        </header>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>قطعه</th>
                <th>ایستگاه نصب</th>
                <th>نیاز</th>
                <th>داخل سبد</th>
                <th>عملیات</th>
              </tr>
            </thead>
            <tbody>
              {basket.needs.map((need) => (
                <tr key={need.skuId}>
                  <td dir="ltr">{need.skuCode}</td>
                  <td dir="ltr">{need.stationCode}</td>
                  <td>{need.quantity}</td>
                  <td>{coverage[need.skuId]?.allocated ?? "0"}</td>
                  <td>
                    {unit.confirmed &&
                      preparing &&
                      access.create &&
                      coverage[need.skuId]?.remaining !== "0" && (
                        <button
                          disabled={locked}
                          onClick={() =>
                            setLabelEditor({
                              ...need,
                              quantity:
                                coverage[need.skuId]?.remaining ??
                                need.quantity,
                            })
                          }
                        >
                          تولید برچسب قطعه
                        </button>
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {unit.confirmed && preparing && access.scan && (
          <form
            className="toolbar panel-pad"
            onSubmit={(event) => {
              event.preventDefault();
              void act("/parts/scan", { skuId, code: partCode });
            }}
          >
            <label>
              ردیف قطعه
              <select
                name="skuId"
                value={skuId}
                required
                onChange={(event) => {
                  setSku(event.target.value);
                  setPartCode("");
                }}
              >
                <option value="">انتخاب قطعه</option>
                {basket.needs.map((need) => (
                  <option key={need.skuId} value={need.skuId}>
                    {need.skuCode}
                  </option>
                ))}
              </select>
            </label>
            <label>
              اسکن برچسب قطعه
              <input
                name="partCode"
                dir="ltr"
                required
                maxLength={80}
                value={partCode}
                onChange={(event) => setPartCode(event.target.value)}
              />
            </label>
            <button className="primary" disabled={locked}>
              اختصاص قطعه به سبد
            </button>
            {access.demo && testPart && (
              <button type="button" onClick={() => setPartCode(testPart.code)}>
                اسکن آزمایشی قطعه
              </button>
            )}
          </form>
        )}
      </section>
      <section className="panel">
        <header className="panel-pad">
          <h2>برچسب‌ها و منشأ قطعات</h2>
        </header>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>برچسب</th>
                <th>قطعه</th>
                <th>کارتن مبدأ</th>
                <th>مقدار</th>
                <th>وضعیت</th>
                <th>عملیات</th>
              </tr>
            </thead>
            <tbody>
              {parts.map((part) => (
                <tr key={part.id}>
                  <td dir="ltr">{part.code}</td>
                  <td dir="ltr">{part.skuCode}</td>
                  <td dir="ltr">{part.cartonCode}</td>
                  <td>{part.quantity}</td>
                  <td>
                    {partStatus[part.state]}
                    {part.reason && <div>{part.reason}</div>}
                  </td>
                  <td>
                    {(part.state === "allocated" ||
                      part.state === "printed") && (
                      <div className="toolbar">
                        {access.create && (
                          <button
                            disabled={locked}
                            onClick={() => setPreview(part)}
                          >
                            چاپ مجدد برچسب
                          </button>
                        )}
                        {preparing && access.edit && (
                          <button
                            disabled={locked}
                            onClick={() => setRemoving(part)}
                          >
                            {part.state === "printed"
                              ? "ابطال برچسب"
                              : "برگشت به خط"}
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!parts.length && (
          <p className="panel-pad">هنوز برچسب قطعه‌ای ثبت نشده است.</p>
        )}
      </section>
      {labelEditor && (
        <PartLabelEditor
          basket={basket}
          need={labelEditor}
          close={() => setLabelEditor(null)}
          saved={(part) => {
            setLabelEditor(null);
            setPreview(part);
            update();
          }}
        />
      )}
      {removing && (
        <RemovePartEditor
          basket={basket}
          part={removing}
          close={() => setRemoving(null)}
          saved={() => {
            setRemoving(null);
            update();
          }}
        />
      )}
      {preview === "imei" && (
        <BarcodeLabel
          title="برچسب IMEI گوشی"
          code={unit.numbers[0]}
          src={labelSrc + "imei/1?pair=" + unit.labelVersion}
          additional={unit.numbers.slice(1).map((code) => ({
            code,
            src: labelSrc + "imei/2?pair=" + unit.labelVersion,
          }))}
          onClose={() => setPreview(null)}
        />
      )}
      {preview && preview !== "imei" && (
        <BarcodeLabel
          title={"برچسب قطعه · " + preview.skuCode}
          code={preview.code}
          src={labelSrc + "parts/" + preview.id}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}
