import { accountLabels } from "./api.js";
import { useEffect, useRef, useState } from "react";
import { useResource } from "../components/useResource.js";
import { errorMessage, request } from "../request/identity.js";

/** @typedef {import("./api.js").Balance} Balance */
/** @typedef {import("./api.js").Pallet} Pallet */
/** @typedef {{kind:"move"|"adjust"|"reserve"|"reverse"|"inspect", carton:Balance, reversesId?:string} | {kind:"pallet", pallet:Pallet}} Action */
const empty = /** @type {import("./api.js").Reservation[]} */ ([]);
const title = {
  move: "جانمایی یا انتقال کارتن",
  pallet: "جانمایی یا انتقال پالت",
  adjust: "ثبت و تأیید اصلاح موجودی",
  reserve: "رزرو موجودی",
  reverse: "ثبت اصلاح جبرانی",
  inspect: "تطبیق مانده با دفتر گردش",
};

/** @param {{action:Action, locations:import("./api.js").Choice[], onClose:()=>void, onSaved:()=>void}} props */
export function InventoryAction({ action, locations, onClose, onSaved }) {
  const dialog = useRef(/** @type {HTMLDialogElement|null} */ (null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);

  const carton = action.kind === "pallet" ? null : action.carton;
  const base = carton ? "/inventory/cartons/" + carton.cartonId : "";

  /** @param {string} path @param {object} body */
  async function command(path, body) {
    setBusy(true);
    setError("");
    try {
      await request(path, { method: "POST", body });
      onSaved();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  /** @param {import("react").FormEvent<HTMLFormElement>} event */
  function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (action.kind === "pallet") {
      void command("/inventory/pallets/" + action.pallet.id + "/moves", {
        items: action.pallet.items,
        locationId: form.get("locationId"),
      });
      return;
    }
    const body = {
      version: action.carton.version,
      reason: form.get("reason"),
      quantity: form.get("quantity"),
      locationId: form.get("locationId"),
      reversesId: action.reversesId,
    };
    const endpoint =
      action.kind === "move"
        ? "/moves"
        : action.kind === "reserve"
          ? "/reservations"
          : "/adjustments";
    void command(base + endpoint, body);
  }

  const isMove = action.kind === "move" || action.kind === "pallet";
  return (
    <dialog
      ref={dialog}
      className="panel editor"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2>{title[action.kind]}</h2>
      <p dir="ltr">
        {carton?.cartonCode ??
          (action.kind === "pallet" ? action.pallet.code : "")}
      </p>
      {carton && (
        <p>
          مانده {carton.quantity} · رزرو {carton.reserved} · آزاد{" "}
          {carton.available}
        </p>
      )}
      {action.kind === "inspect" ? (
        <Reconciliation path={base + "/reconciliation"} />
      ) : (
        <form onSubmit={submit}>
          {isMove && (
            <label>
              موقعیت مقصد
              <select name="locationId" required defaultValue="">
                <option value="">انتخاب موقعیت</option>
                {locations.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.code} · {item.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!isMove && (
            <>
              {action.kind !== "reverse" && (
                <label>
                  {action.kind === "adjust"
                    ? "مقدار اصلاح با علامت مثبت یا منفی"
                    : "مقدار رزرو"}
                  <input
                    name="quantity"
                    inputMode="decimal"
                    dir="ltr"
                    required
                  />
                </label>
              )}
              <label>
                علت
                <textarea
                  name="reason"
                  rows={2}
                  maxLength={500}
                  required={action.kind !== "reserve"}
                />
              </label>
            </>
          )}
          <div>
            <button
              className="primary"
              disabled={busy || (isMove && !locations.length)}
            >
              {action.kind === "adjust" || action.kind === "reverse"
                ? "تأیید و ثبت سند"
                : "ثبت"}
            </button>
          </div>
        </form>
      )}
      {action.kind === "reserve" && (
        <Reservations
          path={base + "/reservations"}
          busy={busy}
          onRelease={(id) => {
            void command(base + "/reservations/" + id + "/release", {
              version: action.carton.version,
            });
          }}
        />
      )}
      {error && <p role="alert">{error}</p>}
      <button type="button" disabled={busy} onClick={onClose}>
        بستن
      </button>
    </dialog>
  );
}

/** @param {{path:string,busy:boolean,onRelease:(id:string)=>void}} props */
function Reservations({ path, busy, onRelease }) {
  const result = useResource(path, empty, 0);
  return (
    <section className="inventory-section">
      <h3>رزروهای فعال</h3>
      {result.error && <p role="alert">{result.error}</p>}
      {result.loading ? (
        <p role="status">در حال دریافت…</p>
      ) : (
        !result.data.length && <p>رزرو فعالی ندارد.</p>
      )}
      {result.data.map((row) => (
        <div key={row.id} className="toolbar">
          <span>
            {row.quantity} {row.reason && "· " + row.reason}
          </span>
          <button disabled={busy} onClick={() => onRelease(row.id)}>
            آزادسازی
          </button>
        </div>
      ))}
    </section>
  );
}

/** @param {{path:string}} props */
function Reconciliation({ path }) {
  const result = useResource(
    path,
    /** @type {import("./api.js").Reconciliation|null} */ (null),
    0,
  );
  if (result.error) return <p role="alert">{result.error}</p>;
  if (!result.data) return <p role="status">در حال تطبیق…</p>;
  return (
    <>
      <p>
        {result.data.balanced
          ? "مانده با دفتر گردش و رزروها سازگار است."
          : "مغایرت مانده با دفتر گردش یا رزروها."}
      </p>
      <p>
        ماندهٔ ثبت‌شده {result.data.actual} · ماندهٔ دفتر {result.data.expected}
      </p>
      <p>
        رزرو ثبت‌شده {result.data.reserved} · مجموع رزروها{" "}
        {result.data.expectedReserved}
      </p>
      {Object.entries(result.data.nonAllocatable ?? {})
        .filter(([, amount]) => amount !== "0")
        .map(([account, amount]) => (
          <p key={account}>
            {accountLabels[/** @type {keyof typeof accountLabels} */ (account)]}{" "}
            {amount}
          </p>
        ))}
      {result.data.basket && (
        <p>مقدار تخصیص‌یافته به سبدها {result.data.basket}</p>
      )}
    </>
  );
}
