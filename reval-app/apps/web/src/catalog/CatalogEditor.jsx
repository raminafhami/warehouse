import { useEffect, useRef, useState } from "react";
import { labels, schemas } from "./catalog.js";
import { useOptions } from "./useOptions.js";
import { errorMessage, request } from "../request/identity.js";

/** @param {{ kind: string, entry?: import("./catalog.js").Entry, onClose: () => void, onSave: () => void }} props */
export function CatalogEditor({ kind, entry, onClose, onSave }) {
  const fields = schemas[kind] ?? [];
  const options = useOptions(
    fields.flatMap((field) => (field.pick ? [field.pick] : [])),
  );
  const dialog = useRef(/** @type {HTMLDialogElement | null} */ (null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const current = dialog.current;
    current?.showModal();
    return () => current?.close();
  }, []);

  /** @param {import("react").FormEvent<HTMLFormElement>} event */
  async function save(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError("");
    setBusy(true);
    try {
      const data = Object.fromEntries(
        fields
          .filter((field) => field.key !== "parentId")
          .map((field) => {
            const value = String(form.get(field.key) ?? "");
            if (field.multiple) return [field.key, form.getAll(field.key)];
            if (field.type === "check") return [field.key, form.has(field.key)];
            if (field.type === "number") return [field.key, Number(value)];
            if (field.type === "lines")
              return [
                field.key,
                value
                  .split(/\r?\n/)
                  .map((item) => item.trim())
                  .filter(Boolean),
              ];
            return [field.key, value];
          }),
      );
      await request("/master/" + kind + (entry ? "/" + entry.id : ""), {
        method: entry ? "PATCH" : "POST",
        body: {
          code: form.get("code"),
          name: form.get("name"),
          parentId: form.get("parentId"),
          version: entry?.version,
          data,
        },
      });
      onSave();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      className="panel editor"
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2>
        {entry ? "ویرایش " : "تعریف "}
        {labels[kind]}
      </h2>
      <form onSubmit={save}>
        <label>
          کد
          <input
            name="code"
            dir="ltr"
            defaultValue={entry?.code}
            disabled={Boolean(entry)}
            required
          />
        </label>
        <label>
          نام
          <input name="name" defaultValue={entry?.name} required />
        </label>
        {options.loading && <p role="status">در حال دریافت گزینه‌ها…</p>}
        {!options.loading &&
          fields
            .filter((field) => !(entry && field.key === "parentId"))
            .map((field) => {
              const value = entry?.data[field.key] ?? field.initial;
              return (
                <label
                  key={field.key}
                  className={field.type === "check" ? "inline" : undefined}
                >
                  {field.label}
                  {field.pick ? (
                    <select
                      name={field.key}
                      multiple={field.multiple}
                      required={!field.optional}
                      defaultValue={value ?? (field.multiple ? [] : "")}
                    >
                      {!field.multiple && <option value="">انتخاب</option>}
                      {options.entries[field.pick]?.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.code} · {option.name}
                        </option>
                      ))}
                    </select>
                  ) : field.type === "lines" ? (
                    <textarea
                      name={field.key}
                      rows={3}
                      required={!field.optional}
                      defaultValue={
                        Array.isArray(value) ? value.join("\n") : ""
                      }
                    />
                  ) : field.type === "check" ? (
                    <input
                      name={field.key}
                      type="checkbox"
                      defaultChecked={Boolean(value)}
                    />
                  ) : (
                    <input
                      name={field.key}
                      type={field.type ?? "text"}
                      defaultValue={value}
                      required={!field.optional}
                    />
                  )}
                </label>
              );
            })}
        {(error || options.error) && (
          <p role="alert">{error || options.error}</p>
        )}
        <div className="toolbar">
          <button
            className="primary"
            disabled={busy || options.loading || Boolean(options.error)}
          >
            ذخیره
          </button>
          <button type="button" onClick={onClose} disabled={busy}>
            انصراف
          </button>
        </div>
      </form>
    </dialog>
  );
}
