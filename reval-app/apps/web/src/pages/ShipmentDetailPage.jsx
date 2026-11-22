import { useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { BarcodeLabel } from "../components/BarcodeLabel.jsx";
import { useResource } from "../components/useResource.js";
import { errorMessage, request, RequestError } from "../request/identity.js";
import {
  allowShipmentAction,
  dateLabel,
  statusLabels,
  uploadWaybill,
} from "../shipments/api.js";

const empty =
  /** @type {import("../shipments/api.js").ShipmentDetail | null} */ (null);
/** @typedef {import("react").FormEvent<HTMLFormElement>} FormEvent */

/** @param {{profile:import("../request/identity.js").Profile}} props */
export function ShipmentDetailPage({ profile }) {
  const { id } = useParams();
  const location = useLocation();
  const [warning, setWarning] = useState(() =>
    typeof location.state?.warning === "string" ? location.state.warning : "",
  );
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [selectedPallet, setSelectedPallet] = useState("");
  const [label, setLabel] = useState(
    /** @type {{code:string,title:string}|null} */ (null),
  );
  const [retryingReceipt, setRetryingReceipt] = useState(false);
  const receiptAttempt = useRef(
    /** @type {{key:string,body:{version:number,reason:string}} | null} */ (
      null
    ),
  );
  const base = "/shipments/" + id;
  const detail = useResource(base, empty, revision);
  const loaded = detail.data;
  const shipment = loaded?.shipment;

  /** @param {() => Promise<unknown>} operation @param {string} success @param {() => void} [after] */
  async function perform(operation, success, after) {
    setBusy(true);
    setError("");
    setWarning("");
    setResult("");
    try {
      await operation();
      after?.();
      setResult(success);
      setRevision((value) => value + 1);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  if (!shipment || !loaded)
    return (
      <>
        <Link to="/shipments">بازگشت به محموله‌ها</Link>
        {detail.error ? (
          <p role="alert">{detail.error}</p>
        ) : (
          <p role="status">در حال بارگیری محموله…</p>
        )}
      </>
    );
  const open = shipment.status !== "approved";
  const scan = open && allowShipmentAction(profile, shipment, "scan");
  const edit = open && allowShipmentAction(profile, shipment, "edit");
  const approve = open && allowShipmentAction(profile, shipment, "approve");
  const attach = open && allowShipmentAction(profile, shipment, "create");
  const print = allowShipmentAction(profile, shipment, "pdf");
  const pending = shipment.scannedCartons > shipment.receivedCartons;
  const needsReason =
    shipment.scannedCartons !== shipment.expectedCartons ||
    loaded.cartons.some((item) => item.condition === "quarantine");
  const pallet = loaded.pallets.some((item) => item.id === selectedPallet)
    ? selectedPallet
    : (loaded.pallets.at(-1)?.id ?? "");
  const inactive = busy || detail.loading || retryingReceipt;

  /** @param {FormEvent} event */
  function receive(event) {
    event.preventDefault();
    if (!shipment) return;
    const form = new FormData(event.currentTarget);
    const attempt = receiptAttempt.current ?? {
      key: crypto.randomUUID(),
      body: {
        version: shipment.version,
        reason: String(form.get("reason") ?? ""),
      },
    };
    receiptAttempt.current = attempt;
    void perform(async () => {
      try {
        await request(base + "/receipts", {
          method: "POST",
          body: attempt.body,
          headers: { "Idempotency-Key": attempt.key },
        });
        receiptAttempt.current = null;
        setRetryingReceipt(false);
      } catch (error) {
        if (error instanceof RequestError && error.status < 500) {
          receiptAttempt.current = null;
          setRetryingReceipt(false);
          if (error.status === 409) setRevision((value) => value + 1);
        } else {
          setRetryingReceipt(true);
        }
        throw error;
      }
    }, "دریافت و گردش موجودی ثبت شد.");
  }

  /** @param {FormEvent} event */
  function upload(event) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const file = new FormData(formElement).get("file");
    if (file instanceof File && file.size && id) {
      void perform(
        () => uploadWaybill(id, file),
        "بارنامه بارگذاری شد.",
        () => formElement.reset(),
      );
    }
  }

  /** @param {FormEvent} event */
  function addPallet(event) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const code = new FormData(formElement).get("palletCode");
    void perform(
      async () => {
        /** @type {import("../shipments/api.js").Pallet} */
        const item = await request(base + "/pallets", {
          method: "POST",
          body: { code },
        });
        setSelectedPallet(item.id);
      },
      "پالت ثبت شد.",
      () => {
        formElement.reset();
        formElement.querySelector("input")?.focus();
      },
    );
  }

  /** @param {FormEvent} event */
  function addCarton(event) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const code = formElement.querySelector(
      /** @type {const} */ ("input[name=cartonCode]"),
    );
    void perform(
      () =>
        request(base + "/cartons", {
          method: "POST",
          body: {
            palletId: pallet,
            code: form.get("cartonCode"),
            skuId: form.get("skuId"),
            lot: form.get("lot"),
            quantity: String(form.get("quantity") ?? ""),
            condition: form.get("condition"),
          },
        }),
      "کارتن ثبت شد.",
      () => {
        if (code instanceof HTMLInputElement) {
          code.value = "";
          code.focus();
        }
      },
    );
  }

  /** @param {FormEvent} event */
  function resolve(event) {
    event.preventDefault();
    if (!shipment) return;
    const reason = new FormData(event.currentTarget).get("resolution");
    void perform(
      () =>
        request(base + "/discrepancy/resolution", {
          method: "POST",
          body: { version: shipment.version, reason },
        }),
      "مغایرت تعیین تکلیف شد.",
    );
  }

  return (
    <>
      <header className="page-header">
        <div>
          <Link to="/shipments">محموله‌ها</Link>
          <h1>
            محمولهٔ <bdi>{shipment.code}</bdi>
          </h1>
        </div>
        <span
          className={shipment.status === "approved" ? "badge active" : "badge"}
        >
          {statusLabels[shipment.status]}
        </span>
      </header>
      <section className="panel panel-pad shipment-summary">
        <p>
          {shipment.supplierName} · {shipment.warehouseName}
        </p>
        <p>
          شمارهٔ بارنامه {shipment.waybillNumber}{" "}
          {shipment.purchaseOrder && "· سفارش " + shipment.purchaseOrder}
        </p>
        <p>
          {shipment.scannedCartons.toLocaleString("fa")} ثبت‌شده ·{" "}
          {shipment.receivedCartons.toLocaleString("fa")} دریافت‌شده ·{" "}
          {shipment.expectedCartons.toLocaleString("fa")} طبق بارنامه
        </p>
        {shipment.notes && <p>{shipment.notes}</p>}
        {shipment.waybill && (
          <a href={"/api/v1" + base + "/waybill"} download>
            دریافت {shipment.waybill.name}
          </a>
        )}
        {attach && (
          <form className="toolbar" onSubmit={upload}>
            <label>
              فایل بارنامه
              <input
                name="file"
                type="file"
                accept="image/jpeg,image/png,application/pdf"
                required
              />
            </label>
            <button disabled={inactive}>بارگذاری بارنامه</button>
          </form>
        )}
      </section>
      {(warning || error || detail.error) && (
        <p role="alert">{warning || error || detail.error}</p>
      )}
      {result && <p role="status">{result}</p>}

      {scan && (
        <section className="panel panel-pad shipment-section">
          <h2>ثبت پالت و اسکن کارتن</h2>
          <form className="toolbar" onSubmit={addPallet}>
            <label>
              بارکد پالت
              <input
                name="palletCode"
                dir="ltr"
                placeholder="PLT-1405-00001"
                required
              />
            </label>
            <button disabled={inactive}>ثبت پالت</button>
          </form>
          {loaded.pallets.length > 0 && (
            <form className="toolbar shipment-section" onSubmit={addCarton}>
              <label>
                پالت
                <select
                  value={pallet}
                  onChange={(event) => setSelectedPallet(event.target.value)}
                >
                  {loaded.pallets.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.code}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                بچ تأمین‌کننده <input name="lot" maxLength={80} />
              </label>
              <label>
                کد کالا
                <select name="skuId" required defaultValue="">
                  <option value="">انتخاب قطعه</option>
                  {loaded.skus.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.code} · {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                تعداد قطعه
                <input
                  name="quantity"
                  inputMode="decimal"
                  dir="ltr"
                  defaultValue="1"
                  required
                />
              </label>
              <label>
                وضعیت کارتن
                <select name="condition">
                  <option value="accepted">سالم</option>
                  <option value="quarantine">قرنطینه</option>
                </select>
              </label>
              <label>
                بارکد کارتن
                <input
                  name="cartonCode"
                  dir="ltr"
                  placeholder="CTN-1405-00001"
                  required
                />
              </label>
              <button
                className="primary"
                disabled={inactive || !loaded.skus.length}
              >
                ثبت کارتن
              </button>
            </form>
          )}
          {loaded.pallets.length > 0 && !loaded.skus.length && (
            <p>کد کالای فعالی برای این تأمین‌کننده تعریف نشده است.</p>
          )}
        </section>
      )}

      {loaded.pallets.map((item) => (
        <section className="panel shipment-section" key={item.id}>
          <div className="toolbar panel-pad">
            <h2>
              پالت <bdi>{item.code}</bdi>
            </h2>
            {print && (
              <button
                onClick={() =>
                  setLabel({ code: item.code, title: "برچسب پالت" })
                }
              >
                بارکد پالت
              </button>
            )}
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>بارکد کارتن</th>
                  <th>کد کالا</th>
                  <th>تعداد</th>
                  <th>وضعیت</th>
                  {(edit || print) && <th>عملیات</th>}
                </tr>
              </thead>
              <tbody>
                {loaded.cartons
                  .filter((carton) => carton.palletId === item.id)
                  .map((carton) => (
                    <tr key={carton.id}>
                      <td>
                        <bdi>{carton.code}</bdi>
                      </td>
                      <td>
                        {carton.skuCode}
                        {carton.lot && <small> · بچ {carton.lot}</small>}
                      </td>
                      <td>{carton.quantity}</td>
                      <td>
                        {carton.condition === "quarantine" ? "قرنطینه" : "سالم"}{" "}
                        ·{" "}
                        {carton.state === "received"
                          ? "دریافت‌شده"
                          : "اسکن‌شده"}
                      </td>
                      {(edit || print) && (
                        <td>
                          {print && (
                            <button
                              onClick={() =>
                                setLabel({
                                  code: carton.code,
                                  title: "برچسب کارتن",
                                })
                              }
                            >
                              بارکد کارتن
                            </button>
                          )}
                          {edit && carton.state === "scanned" && (
                            <button
                              disabled={inactive}
                              onClick={() => {
                                void perform(
                                  () =>
                                    request(base + "/cartons/" + carton.id, {
                                      method: "DELETE",
                                    }),
                                  "کارتن از دریافت خارج شد.",
                                );
                              }}
                            >
                              حذف کارتن
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      {(approve || shipment.discrepancy || loaded.receipts.length > 0) && (
        <section className="panel panel-pad shipment-section">
          <h2>دریافت انبار</h2>
          {shipment.discrepancy && (
            <p>شرح مغایرت: {shipment.discrepancy.reason}</p>
          )}
          {shipment.resolution && (
            <p>نتیجهٔ رسیدگی: {shipment.resolution.reason}</p>
          )}
          {approve && (pending || retryingReceipt) && (
            <form className="version-editor" onSubmit={receive}>
              <label>
                شرح مغایرت
                <textarea
                  name="reason"
                  maxLength={500}
                  rows={2}
                  required={needsReason && !retryingReceipt}
                  disabled={retryingReceipt}
                />
              </label>
              {retryingReceipt && (
                <p>
                  نتیجهٔ دریافت مشخص نیست. تلاش دوباره با همان درخواست انجام
                  می‌شود.
                </p>
              )}
              <div>
                <button className="primary" disabled={busy || detail.loading}>
                  {retryingReceipt ? "تلاش دوباره برای دریافت" : "تأیید دریافت"}
                </button>
              </div>
            </form>
          )}
          {approve &&
            !pending &&
            !retryingReceipt &&
            shipment.status === "discrepancy" && (
              <form className="version-editor" onSubmit={resolve}>
                <label>
                  شرح تعیین تکلیف
                  <textarea
                    name="resolution"
                    required
                    maxLength={500}
                    rows={2}
                  />
                </label>
                <div>
                  <button disabled={inactive}>تعیین تکلیف مغایرت</button>
                </div>
              </form>
            )}
          {loaded.receipts.length > 0 && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>تاریخ</th>
                    <th>کارتن دریافت‌شده</th>
                    <th>قرنطینه</th>
                    <th>شرح</th>
                  </tr>
                </thead>
                <tbody>
                  {loaded.receipts.map((item) => (
                    <tr key={item.id}>
                      <td>{dateLabel.format(new Date(item.at))}</td>
                      <td>{item.cartonCount.toLocaleString("fa")}</td>
                      <td>{item.quarantinedCount.toLocaleString("fa")}</td>
                      <td>{item.reason || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {label && (
        <BarcodeLabel
          title={label.title}
          code={label.code}
          src={"/api/v1" + base + "/labels/" + encodeURIComponent(label.code)}
          onClose={() => setLabel(null)}
        />
      )}
    </>
  );
}
