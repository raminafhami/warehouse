import { openPrintPreview } from "../components/PrintPreview.jsx";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useResource } from "../components/useResource.js";
import {
  deliveryStatus,
  requestStatus,
  useHandoverCommand,
} from "../handover/api.js";
import { errorMessage, RequestError } from "../request/identity.js";

/** @typedef {import("../handover/api.js").Detail} Detail */
/** @typedef {import("../handover/api.js").Delivery} Delivery */
/** @typedef {import("../handover/api.js").Item} Item */
/** @typedef {import("react").FormEvent<HTMLFormElement>} FormEvent */
/** @typedef {(operation:()=>Promise<unknown>,success:string,after?:()=>void)=>Promise<void>} Perform */

/** @param {{profile:import("../request/identity.js").Profile,selectedId?:string,onUpdated?:()=>void}} props */
export function HandoverDetailPage({ profile, selectedId, onUpdated }) {
  const { id } = useParams();
  const base = "/handover/requests/" + (selectedId ?? id);
  const [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [barcode, setBarcode] = useState("");
  const command = useHandoverCommand();
  const resource = useResource(
    base,
    /** @type {Detail|null} */ (null),
    revision,
  );
  const data = resource.data;
  /** @type {Perform} */
  async function perform(operation, success, after) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
      after?.();
      setNotice(success);
      setRevision((value) => value + 1);
      onUpdated?.();
    } catch (error) {
      setError(errorMessage(error));
      if (error instanceof RequestError && error.status === 409)
        setRevision((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return (
      <>
        {!selectedId && <Link to="/handover">بازگشت به درخواست‌ها</Link>}
        {resource.error ? (
          <p role="alert">{resource.error}</p>
        ) : (
          <p role="status">در حال دریافت…</p>
        )}
      </>
    );
  const row = data.request;
  const open = row.status === "open" || row.status === "partial";
  const disabled = busy || resource.loading;

  /** @param {FormEvent} event */
  function reserve(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void perform(
      () =>
        command(base + "/reservations", {
          version: row.version,
          cartonCode: barcode,
          quantity: form.get("quantity"),
        }),
      "کارتن برای درخواست رزرو شد.",
      () => setBarcode(""),
    );
  }
  /** @param {FormEvent} event */
  function issue(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void perform(
      () =>
        command(base + "/deliveries", {
          version: row.version,
          reservationIds: form.getAll("reservationIds"),
        }),
      "حواله صادر و موجودی به در راه منتقل شد.",
    );
  }
  /** @param {FormEvent} event */
  function cancel(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void perform(
      () =>
        command(base + "/cancel", {
          version: row.version,
          reason: form.get("cancelReason"),
        }),
      "ماندهٔ درخواست لغو و رزروهای باز آزاد شدند.",
    );
  }
  return (
    <>
      <section className="panel handover-request">
        <header className="panel-heading">
          <div>
            {!selectedId && <Link to="/handover">درخواست‌ها</Link>}
            {selectedId ? (
              <h2>
                <bdi>{row.code}</bdi>
              </h2>
            ) : (
              <h1>
                درخواست مواد <bdi>{row.code}</bdi>
              </h1>
            )}
            <p className="insights-context">
              {row.modelName} · {row.count.toLocaleString("fa-IR")} گوشی ·{" "}
              {row.lineName} · BOM نسخهٔ{" "}
              {row.bomRevision.toLocaleString("fa-IR")}
            </p>
          </div>
          <span
            className={
              row.status === "fulfilled"
                ? "badge info"
                : row.status === "open"
                  ? "badge warn"
                  : "badge"
            }
          >
            {requestStatus[row.status]}
          </span>
        </header>
        {row.cancellationReason && (
          <p className="panel-pad">علت لغو مانده {row.cancellationReason}</p>
        )}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>قطعه</th>
                <th>مورد نیاز</th>
                <th>کارتن‌های انتخاب‌شده</th>
                <th>صادرشده</th>
                <th>وضعیت</th>
              </tr>
            </thead>
            <tbody>
              {row.needs.map((item) => (
                <tr key={item.skuId}>
                  <td>
                    <bdi>{item.skuCode}</bdi>
                  </td>
                  <td>{item.required}</td>
                  <td>
                    {data.reservations
                      .filter((reservation) => reservation.skuId === item.skuId)
                      .map((reservation) => (
                        <bdi key={reservation.id}>
                          {reservation.cartonCode}{" "}
                        </bdi>
                      ))}
                  </td>
                  <td>{item.issued}</td>
                  <td>
                    <span
                      className={
                        item.issued === item.required
                          ? "badge active"
                          : "badge neutral"
                      }
                    >
                      {item.issued === item.required
                        ? "صادرشده"
                        : "در انتظار تحویل"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {(error || resource.error) && (
        <p role="alert">{error || resource.error}</p>
      )}
      {notice && <p role="status">{notice}</p>}
      {open && data.access.transfer && (
        <section className="panel panel-pad shipment-section">
          <h2>آماده‌سازی تحویل و اسکن کارتن‌ها</h2>
          <form className="toolbar scan-controls" onSubmit={reserve}>
            <label>
              بارکد کارتن
              <input
                name="cartonCode"
                dir="ltr"
                placeholder="بارکد کارتن را اسکن کنید"
                value={barcode}
                onChange={(event) => setBarcode(event.target.value)}
                required
              />
            </label>
            <label>
              مقدار
              <input
                name="quantity"
                dir="ltr"
                defaultValue="1"
                inputMode="decimal"
                required
              />
            </label>
            <button className="primary" disabled={disabled}>
              افزودن
            </button>
          </form>
          {data.stock.length > 0 && (
            <div className="stock-choices">
              {data.stock.map((item) => (
                <button
                  type="button"
                  aria-pressed={item.cartonCode === barcode}
                  key={item.id}
                  onClick={() => setBarcode(item.cartonCode)}
                >
                  <bdi>{item.cartonCode}</bdi>
                  <small>
                    <bdi>{item.skuCode}</bdi> · آزاد {item.available}
                  </small>
                </button>
              ))}
            </div>
          )}
          {!data.stock.length && (
            <p>برای اقلام این BOM موجودی آزادِ قابل صدور پیدا نشد.</p>
          )}
        </section>
      )}
      {data.reservations.length > 0 && (
        <section className="panel panel-pad shipment-section">
          <h2>رزروهای این درخواست</h2>
          <form onSubmit={issue}>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>انتخاب</th>
                    <th>کارتن</th>
                    <th>مقدار</th>
                    <th>عملیات</th>
                  </tr>
                </thead>
                <tbody>
                  {data.reservations.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={"انتخاب " + item.cartonCode}
                          name="reservationIds"
                          value={item.id}
                          defaultChecked
                          disabled={!data.access.transfer}
                        />
                      </td>
                      <td>
                        <bdi>{item.cartonCode}</bdi>
                      </td>
                      <td>{item.quantity}</td>
                      <td>
                        {open && data.access.transfer && (
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() =>
                              void perform(
                                () =>
                                  command(
                                    base +
                                      "/reservations/" +
                                      item.id +
                                      "/release",
                                    { version: row.version },
                                  ),
                                "رزرو آزاد شد.",
                              )
                            }
                          >
                            آزادسازی
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {open && data.access.transfer && (
              <button className="primary" disabled={disabled}>
                صدور حواله
              </button>
            )}
          </form>
        </section>
      )}
      {open && data.access.cancel && (
        <section className="panel panel-pad shipment-section">
          <h2>لغو ماندهٔ درخواست</h2>
          <form className="toolbar" onSubmit={cancel}>
            <label>
              علت لغو
              <input name="cancelReason" maxLength={500} required />
            </label>
            <button disabled={disabled}>لغو و آزادسازی رزروهای باز</button>
          </form>
        </section>
      )}
      {data.deliveries.map((delivery) => (
        <DeliveryPanel
          key={delivery.id + ":" + delivery.version}
          delivery={delivery}
          items={data.custody.filter((item) => item.deliveryId === delivery.id)}
          data={data}
          printAllowed={profile.permissions.includes("handover:pdf")}
          disabled={disabled}
          perform={perform}
          command={command}
        />
      ))}
    </>
  );
}

/** @param {{delivery:Delivery,items:Item[],data:Detail,printAllowed:boolean,disabled:boolean,perform:Perform,command:(path:string,body:object)=>Promise<unknown>}} props */
function DeliveryPanel({
  delivery,
  items,
  data,
  printAllowed,
  disabled,
  perform,
  command,
}) {
  const [mode, setMode] = useState("receive");
  const transit = items.some((item) => Number(item.transit) > 0);
  const onLine = items.some((item) => Number(item.line) > 0);
  const receiving =
    transit &&
    (data.access.approve || data.access.reject) &&
    delivery.issuerId !== data.access.actorId;
  const returnTransit =
    data.access.transfer && transit && delivery.status !== "issued";
  const returnLine = data.access.transfer && onLine;
  const canAct =
    mode === "receive"
      ? receiving
      : mode === "transit"
        ? returnTransit
        : returnLine;
  const selected = mode === "line" ? "line" : "transit";

  /** @param {FormEvent} event */
  function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const quantities = items.flatMap((item) => {
      const quantity = String(form.get("qty-" + item.id) ?? "").trim();
      return quantity && Number(quantity) !== 0
        ? [{ itemId: item.id, quantity }]
        : [];
    });
    const payload = {
      version: delivery.version,
      reason: form.get("reason"),
      items: quantities,
      source: mode === "receive" ? undefined : mode,
    };
    void perform(
      () =>
        command(
          "/handover/deliveries/" +
            delivery.id +
            (mode === "receive" ? "/receipts" : "/returns"),
          payload,
        ),
      mode === "receive" ? "نتیجهٔ دریافت ثبت شد." : "برگشت به انبار ثبت شد.",
    );
  }
  return (
    <section className="panel panel-pad shipment-section">
      <header className="page-header">
        <h2>
          حواله <bdi>{delivery.code}</bdi>
        </h2>
        <div className="toolbar">
          <span className="badge">{deliveryStatus[delivery.status]}</span>
          {printAllowed && (
            <button onClick={() => openPrintPreview()}>چاپ</button>
          )}
        </div>
      </header>
      {delivery.reason && <p>{delivery.reason}</p>}
      {transit &&
        (data.access.approve || data.access.reject) &&
        delivery.issuerId === data.access.actorId && (
          <p>دریافت باید توسط کاربر دیگری در خط تأیید شود.</p>
        )}
      <form onSubmit={submit}>
        {(receiving || returnTransit || returnLine) && (
          <label>
            عملیات
            <select
              value={mode}
              onChange={(event) => setMode(event.target.value)}
            >
              <option value="receive">ثبت دریافت در خط</option>
              {returnTransit && (
                <option value="transit">برگشت کسری از در راه</option>
              )}
              {returnLine && (
                <option value="line">برگشت مواد مصرف‌نشده از خط</option>
              )}
            </select>
          </label>
        )}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>کارتن</th>
                <th>کالا</th>
                <th>صادرشده</th>
                <th>در راه</th>
                <th>در خط</th>
                <th>برگشت</th>
                {canAct && <th>مقدار عملیات</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <bdi>{item.cartonCode}</bdi>
                  </td>
                  <td>
                    <bdi>{item.skuCode}</bdi>
                  </td>
                  <td>{item.issued}</td>
                  <td>{item.transit}</td>
                  <td>{item.line}</td>
                  <td>{item.returned}</td>
                  {canAct && (
                    <td>
                      {Number(item[selected]) > 0 && (
                        <input
                          key={mode}
                          aria-label={"مقدار " + item.cartonCode}
                          name={"qty-" + item.id}
                          inputMode="decimal"
                          dir="ltr"
                          defaultValue={
                            mode === "receive" && data.access.approve
                              ? item.transit
                              : ""
                          }
                        />
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {canAct && (
          <div className="toolbar panel-pad">
            <label>
              شرح یا علت
              <input
                name="reason"
                maxLength={500}
                required={mode !== "receive"}
              />
            </label>
            <button className="primary" disabled={disabled}>
              {mode === "receive"
                ? "ثبت دریافت یا مغایرت"
                : "تأیید برگشت به انبار"}
            </button>
          </div>
        )}
      </form>
    </section>
  );
}
