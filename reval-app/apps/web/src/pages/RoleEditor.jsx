import { useState } from "react";
import { FormDialog } from "../components/FormDialog.jsx";
import { errorMessage, request } from "../request/identity.js";

/** @param {{ catalogue: import("../request/identity.js").Catalogue, editable: boolean, onSaved: () => void }} props */
export function RoleEditor({ catalogue, editable, onSaved }) {
  const [selected, setSelected] = useState(catalogue.roles[0]?._id ?? "");
  const [creating, setCreating] = useState(false);
  const role = catalogue.roles.find((item) => item._id === selected);
  return (
    <section className="panel">
      <div className="toolbar panel-pad">
        <label>
          نقش
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            {catalogue.roles.map((item) => (
              <option value={item._id} key={item._id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        {editable && (
          <button
            type="button"
            className="primary"
            onClick={() => setCreating(true)}
          >
            نقش جدید
          </button>
        )}
      </div>
      {role && (
        <PermissionForm
          key={JSON.stringify(role ?? null)}
          role={role}
          catalogue={catalogue}
          editable={editable && role?._id !== "superadmin"}
          onSaved={(id) => {
            setSelected(id);
            onSaved();
          }}
        />
      )}
      {editable && creating && (
        <PermissionForm
          catalogue={catalogue}
          editable
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            setSelected(id);
            onSaved();
          }}
        />
      )}
    </section>
  );
}

/** @param {{ role?: import("../request/identity.js").Role, catalogue: import("../request/identity.js").Catalogue, editable: boolean, onSaved: (id: string) => void, onClose?:()=>void }} props */
function PermissionForm({ role, catalogue, editable, onSaved, onClose }) {
  const [permissions, setPermissions] = useState(
    () => new Set(role?.permissions ?? []),
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  /** @param {import("react").FormEvent<HTMLFormElement>} event */
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const form = new FormData(event.currentTarget);
      /** @type {import("../request/identity.js").Role} */
      const saved = await request(role ? "/roles/" + role._id : "/roles", {
        method: role ? "PATCH" : "POST",
        body: {
          name: form.get("name"),
          permissions: [...permissions],
          previousPermissions: role?.permissions,
        },
      });
      onSaved(saved._id);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const form = (
    <form onSubmit={save}>
      {!role && (
        <label className="panel-pad">
          نام نقش
          <input name="name" required />
        </label>
      )}
      <div className="table-scroll">
        <table className="matrix">
          <thead>
            <tr>
              <th>ماژول</th>
              {Object.entries(catalogue.actions).map(([id, label]) => (
                <th key={id}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.entries(catalogue.modules).map(([moduleId, moduleName]) => (
              <tr key={moduleId}>
                <th scope="row">{moduleName}</th>
                {Object.entries(catalogue.actions).map(
                  ([actionId, actionName]) => {
                    const key = moduleId + ":" + actionId;
                    return (
                      <td key={key}>
                        <input
                          type="checkbox"
                          aria-label={moduleName + "، " + actionName}
                          checked={permissions.has(key)}
                          disabled={!editable || busy}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setPermissions((previous) => {
                              const next = new Set(previous);
                              if (checked) next.add(key);
                              else next.delete(key);
                              return next;
                            });
                          }}
                        />
                      </td>
                    );
                  },
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && (
        <p role="alert" className="panel-pad">
          {error}
        </p>
      )}
      {editable && (
        <div className="panel-pad">
          <button className="primary" disabled={busy}>
            {role ? "ذخیرهٔ مجوزها" : "ایجاد نقش"}
          </button>
          {onClose && (
            <button type="button" disabled={busy} onClick={onClose}>
              انصراف
            </button>
          )}
        </div>
      )}
    </form>
  );
  return onClose ? (
    <FormDialog title="تعریف نقش جدید" busy={busy} onClose={onClose}>
      {form}
    </FormDialog>
  ) : (
    form
  );
}
