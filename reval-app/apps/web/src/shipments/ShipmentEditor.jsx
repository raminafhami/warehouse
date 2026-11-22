import { useEffect, useRef, useState } from "react";
import { useResource } from "../components/useResource.js";
import { errorMessage, request } from "../request/identity.js";
import { uploadWaybill } from "./api.js";

const emptyOptions =
  /** @type {{warehouses:import("./api.js").Choice[],suppliers:import("./api.js").Choice[]}} */ ({
    warehouses: [],
    suppliers: [],
  });

/** @param {{ onClose: () => void, onCreated: (id:string, warning:string) => void }} props */
export function ShipmentEditor({ onClose, onCreated }) {
  const options = useResource("/shipments/options", emptyOptions, 0);
  const dialog = useRef(/** @type {HTMLDialogElement|null} */ (null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  /** @param {import("react").FormEvent<HTMLFormElement>} event */
  async function create(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      /** @type {import("./api.js").Shipment} */
      const shipment = await request("/shipments", {
        method: "POST",
        body: {
          warehouseId: form.get("warehouseId"),
          supplierId: form.get("supplierId"),
          waybillNumber: form.get("waybillNumber"),
          purchaseOrder: form.get("purchaseOrder"),
          expectedCartons: Number(form.get("expectedCartons")),
          notes: form.get("notes"),
        },
      });
      const file = form.get("file");
      let warning = "";
      if (file instanceof File && file.size) {
        try {
          await uploadWaybill(shipment.id, file);
        } catch (error) {
          warning =
            "محموله ثبت شد. بارنامه بارگذاری نشد. " + errorMessage(error);
        }
      }
      onCreated(shipment.id, warning);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="panel editor"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2>ثبت محموله جدید</h2>
      <form onSubmit={create}>
        <label>
          انبار مقصد
          <select name="warehouseId" required defaultValue="">
            <option value="">انتخاب انبار</option>
            {options.data.warehouses.map((item) => (
              <option key={item.id} value={item.id}>
                {item.code} · {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          تأمین‌کننده
          <select name="supplierId" required defaultValue="">
            <option value="">انتخاب تأمین‌کننده</option>
            {options.data.suppliers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.code} · {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          شمارهٔ بارنامه یا سند حمل
          <input name="waybillNumber" required maxLength={80} />
        </label>
        <label>
          شمارهٔ سفارش خرید
          <input name="purchaseOrder" maxLength={80} />
        </label>
        <label>
          تعداد کارتن طبق بارنامه
          <input
            name="expectedCartons"
            type="number"
            min={1}
            max={10000}
            required
          />
        </label>
        <label>
          فایل بارنامه
          <input
            name="file"
            type="file"
            accept="image/jpeg,image/png,application/pdf"
          />
        </label>
        <label>
          توضیحات
          <textarea name="notes" maxLength={500} rows={2} />
        </label>
        {(error || options.error) && (
          <p role="alert">{error || options.error}</p>
        )}
        {options.loading && <p role="status">در حال دریافت فهرست…</p>}
        {!options.loading &&
          !options.error &&
          (!options.data.warehouses.length ||
            !options.data.suppliers.length) && (
            <p>
              برای ثبت محموله دست‌کم یک انبار مجاز و یک تأمین‌کنندهٔ فعال لازم
              است.
            </p>
          )}
        <div className="toolbar">
          <button
            className="primary"
            disabled={
              busy ||
              options.loading ||
              !options.data.warehouses.length ||
              !options.data.suppliers.length
            }
          >
            ایجاد و ادامهٔ ثبت پالت‌ها
          </button>
          <button type="button" onClick={onClose} disabled={busy}>
            انصراف
          </button>
        </div>
      </form>
    </dialog>
  );
}
