import { useState } from "react";
import { FormDialog } from "../components/FormDialog.jsx";
import { useResource } from "../components/useResource.js";
import { errorMessage } from "../request/identity.js";
import { useCommand } from "../request/useCommand.js";

/** @typedef {import("./api.js").Basket} Basket */
/** @typedef {import("./api.js").Need} Need */
/** @typedef {import("./api.js").Part} Part */

const noStock = /** @type {import("./api.js").Stock[]} */ ([]);

/** @param {{basket:Basket,need:Need,close:()=>void,saved:(part:Part)=>void}} props */
export function PartLabelEditor({ basket, need, close, saved }) {
  const [q, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const command = useCommand();
  const stock = useResource(
    "/basket/" +
      basket.id +
      "/stock?" +
      new URLSearchParams({ skuId: need.skuId, q }),
    noStock,
    0,
  );
  /** @param {import("react").FormEvent<HTMLFormElement>} event */
  async function create(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const quantity = new FormData(event.currentTarget).get("quantity");
    try {
      /** @type {{basket:Basket,part:Part}} */
      const result = await command("/basket/" + basket.id + "/parts", {
        version: basket.version,
        skuId: need.skuId,
        custodyId: source,
        quantity,
      });
      saved(result.part);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <FormDialog
      title={"تولید برچسب قطعه · " + need.skuCode}
      onClose={close}
      busy={busy}
    >
      <form onSubmit={create}>
        <label>
          جست‌وجوی کارتن
          <input
            value={q}
            onChange={(event) => {
              setQuery(event.target.value);
              setSource("");
            }}
          />
        </label>
        <label>
          کارتن مبدأ
          <select
            name="custodyId"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            required
          >
            <option value="">انتخاب کارتن</option>
            {stock.data.map((row) => (
              <option key={row.id} value={row.id}>
                {row.cartonCode} · ماندهٔ خط {row.line}
              </option>
            ))}
          </select>
        </label>
        <label>
          مقدار
          <input
            name="quantity"
            dir="ltr"
            inputMode="decimal"
            required
            maxLength={34}
            defaultValue={need.quantity}
          />
        </label>
        {!stock.loading && !stock.data.length && (
          <p>موجودی قابل تخصیص در خط پیدا نشد.</p>
        )}
        {(error || stock.error) && <p role="alert">{error || stock.error}</p>}
        <div className="toolbar">
          <button
            className="primary"
            disabled={busy || stock.loading || !source}
          >
            تولید و پیش‌نمایش
          </button>
          <button type="button" disabled={busy} onClick={close}>
            انصراف
          </button>
        </div>
      </form>
    </FormDialog>
  );
}

/** @param {{basket:Basket,part:Part,close:()=>void,saved:()=>void}} props */
export function RemovePartEditor({ basket, part, close, saved }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const command = useCommand();
  const title = part.state === "printed" ? "ابطال برچسب" : "برگشت قطعه به خط";
  /** @param {import("react").FormEvent<HTMLFormElement>} event */
  async function remove(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const reason = new FormData(event.currentTarget).get("reason");
    try {
      await command("/basket/" + basket.id + "/parts/" + part.id + "/remove", {
        version: basket.version,
        reason,
      });
      saved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <FormDialog title={title} onClose={close} busy={busy}>
      <form onSubmit={remove}>
        <p>
          <bdi>{part.code}</bdi> · {part.skuCode} · {part.quantity}
        </p>
        <label>
          علت
          <textarea name="reason" required maxLength={500} />
        </label>
        {error && <p role="alert">{error}</p>}
        <div className="toolbar">
          <button className="primary" disabled={busy}>
            ثبت
          </button>
          <button type="button" disabled={busy} onClick={close}>
            انصراف
          </button>
        </div>
      </form>
    </FormDialog>
  );
}
