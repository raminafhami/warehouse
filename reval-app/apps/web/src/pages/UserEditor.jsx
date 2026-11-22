import { useEffect, useRef, useState } from "react";
import { useResource } from "../components/useResource.js";
import { errorMessage, request } from "../request/identity.js";

/** @typedef {import("../request/identity.js").User} User */
/** @typedef {import("../request/identity.js").Role} Role */
const labels = {
  branchId: "شناسهٔ شعبه",
  warehouseId: "شناسهٔ انبار",
  lineId: "شناسهٔ خط",
  stationId: "شناسهٔ ایستگاه",
};
/** @type {Record<string, string>} */
const scopeKinds = {
  branchId: "branches",
  warehouseId: "warehouses",
  lineId: "lines",
  stationId: "stations",
};
const emptyScopeOptions =
  /** @type {import("../catalog/catalog.js").Entry[]} */ ([]);

/** @param {{ user: User | null, roles: Role[], onDone: () => void, onClose: () => void }} props */
export function UserEditor({ user, roles, onDone, onClose }) {
  const [wide, setWide] = useState(user?.organizationWide ?? false);
  const [scopes, setScopes] = useState(
    user?.scopes?.length ? user.scopes : [{}],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const options = useResource("/master/scope-options", emptyScopeOptions, 0);
  const dialogRef = useRef(/** @type {HTMLDialogElement | null} */ (null));
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  /** @param {object} body */
  async function save(body) {
    setBusy(true);
    setError("");
    try {
      await request(user ? "/users/" + user.id : "/users", {
        method: user ? "PATCH" : "POST",
        body,
      });
      onDone();
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
    void save({
      name: form.get("name"),
      username: form.get("username"),
      password: form.get("password"),
      roleId: form.get("roleId"),
      unit: form.get("unit"),
      version: user?.version,
      organizationWide: wide,
      scopes: wide
        ? []
        : scopes.map((scope) =>
            Object.fromEntries(
              Object.entries(scope).filter(([, value]) => value.trim()),
            ),
          ),
    });
  }

  return (
    <dialog
      ref={dialogRef}
      className="panel editor"
      aria-labelledby="user-editor-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 id="user-editor-title">{user ? "ویرایش کاربر" : "ایجاد کاربر"}</h2>
      <form onSubmit={submit}>
        <label>
          نام و نام خانوادگی
          <input name="name" defaultValue={user?.name} required />
        </label>
        {!user && (
          <>
            <label>
              نام کاربری
              <input
                name="username"
                dir="ltr"
                pattern="[A-Za-z0-9][A-Za-z0-9._\-]{2,63}"
                required
              />
            </label>
            <label>
              رمز اولیه
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
              />
            </label>
          </>
        )}
        <label>
          نقش
          <select name="roleId" defaultValue={user?.roleId} required>
            <option value="">انتخاب نقش</option>
            {roles.map((role) => (
              <option key={role._id} value={role._id}>
                {role.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          واحد
          <input name="unit" defaultValue={user?.unit} />
        </label>
        <label className="inline">
          <input
            type="checkbox"
            checked={wide}
            onChange={(e) => setWide(e.target.checked)}
          />
          دسترسی در کل سازمان
        </label>
        {!wide && (
          <div className="scopes">
            {scopes.map((scope, i) => (
              <fieldset key={i}>
                <legend>محدودهٔ {(i + 1).toLocaleString("fa")}</legend>
                {Object.entries(labels).map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <select
                      value={scope[key] ?? ""}
                      disabled={options.loading || Boolean(options.error)}
                      onChange={(e) => {
                        const value = e.target.value;
                        setScopes((previous) =>
                          previous.map((entry, index) =>
                            index === i ? { ...entry, [key]: value } : entry,
                          ),
                        );
                      }}
                    >
                      <option value="">انتخاب نشده</option>
                      {scope[key] &&
                        !options.data.some(
                          (item) => item.id === scope[key],
                        ) && (
                          <option value={scope[key]}>
                            {scope[key]} · خارج از فهرست فعال
                          </option>
                        )}
                      {options.data
                        .filter((item) => item.kind === scopeKinds[key])
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.code} · {item.name}
                          </option>
                        ))}
                    </select>
                  </label>
                ))}
                {scopes.length > 1 && (
                  <button
                    type="button"
                    onClick={() =>
                      setScopes((previous) =>
                        previous.filter((_, index) => i !== index),
                      )
                    }
                  >
                    حذف محدوده
                  </button>
                )}
              </fieldset>
            ))}
            <button
              type="button"
              onClick={() => setScopes((previous) => [...previous, {}])}
            >
              افزودن محدوده
            </button>
          </div>
        )}
        {(error || (!wide && options.error)) && (
          <p role="alert">{error || options.error}</p>
        )}
        <div className="toolbar">
          <button
            className="primary"
            disabled={
              busy || (!wide && (options.loading || Boolean(options.error)))
            }
          >
            ذخیره
          </button>
          <button type="button" onClick={onClose} disabled={busy}>
            انصراف
          </button>
          {user && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void save({ active: !user.active, version: user.version })
              }
            >
              {user.active ? "غیرفعال‌سازی حساب" : "فعال‌سازی حساب"}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
