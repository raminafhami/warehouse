import { openPrintPreview } from "../components/PrintPreview.jsx";
import { useState } from "react";
import { Pagination } from "../components/Pagination.jsx";
import { useResource } from "../components/useResource.js";
import { errorMessage, request } from "../request/identity.js";
import { RoleEditor } from "./RoleEditor.jsx";
import { UserEditor } from "./UserEditor.jsx";

/** @typedef {import("../request/identity.js").User} User */
/** @typedef {import("../request/identity.js").Catalogue} Catalogue */
const empty = /** @type {{ data: User[], count: number }} */ ({
  data: [],
  count: 0,
});
const noRoles = /** @type {Catalogue} */ ({
  roles: [],
  modules: {},
  actions: {},
});
const noLineFilters =
  /** @type {{ all: number, shared: number, lines: { id: string, name: string, code: string, branchCode: string, count: number }[] }} */ ({
    all: 0,
    shared: 0,
    lines: [],
  });

/** @param {{ profile: import("../request/identity.js").Profile }} props */
export function UsersPage({ profile }) {
  const [tab, setTab] = useState("users");
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [line, setLine] = useState("");
  const [revision, setRevision] = useState(0);
  const [editor, setEditor] = useState(
    /** @type {User | null | undefined} */ (undefined),
  );
  const [printError, setPrintError] = useState("");
  const query = new URLSearchParams({ page: String(page), q: search });
  if (line) query.set("line", line);
  const catalogue = useResource("/roles", noRoles, revision);
  const users = useResource("/users?" + query, empty, revision);
  const lineFilters = useResource(
    "/users/line-filters",
    noLineFilters,
    revision,
  );
  const administrator = profile.roleId === "superadmin";
  const manage = profile.permissions.includes("users:users");
  const roles = catalogue.data.roles;
  const assignable = roles.filter(
    (role) =>
      role._id !== "superadmin" &&
      (administrator || !role.permissions.includes("users:users")),
  );

  async function printUsers() {
    setPrintError("");
    try {
      await request("/users/export?" + query);
      openPrintPreview();
    } catch (error) {
      setPrintError(errorMessage(error));
    }
  }

  return (
    <>
      <header className="page-header">
        <h1>کاربران، نقش‌ها و سطح دسترسی</h1>
        <div className="toolbar">
          {tab === "users" && profile.permissions.includes("users:pdf") && (
            <button
              disabled={users.loading || Boolean(users.error)}
              onClick={() => void printUsers()}
            >
              PDF
            </button>
          )}
          {tab === "users" && manage && (
            <button
              className="primary"
              disabled={!assignable.length}
              onClick={() => setEditor(null)}
            >
              کاربر جدید
            </button>
          )}
        </div>
      </header>
      <div className="tabs">
        <button aria-pressed={tab === "users"} onClick={() => setTab("users")}>
          کاربران {lineFilters.data.all.toLocaleString("fa-IR")}
        </button>
        <button aria-pressed={tab === "roles"} onClick={() => setTab("roles")}>
          نقش‌ها و ماتریس دسترسی {roles.length.toLocaleString("fa-IR")}
        </button>
      </div>
      {(catalogue.error || printError) && (
        <p role="alert">{catalogue.error || printError}</p>
      )}
      {tab === "users" ? (
        <section className="panel">
          <div className="panel-heading user-filters">
            <div className="chips" aria-label="خط تولید">
              {[
                { id: "", label: "همه", count: lineFilters.data.all },
                {
                  id: "shared",
                  label: "واحدهای مشترک",
                  count: lineFilters.data.shared,
                },
                ...lineFilters.data.lines.map((item) => ({
                  id: item.id,
                  label: item.name,
                  count: item.count,
                })),
              ].map(({ id, label, count }) => (
                <button
                  type="button"
                  key={id}
                  aria-pressed={line === id}
                  disabled={lineFilters.loading || Boolean(lineFilters.error)}
                  onClick={() => {
                    setLine(id);
                    setPage(0);
                  }}
                >
                  {label} ({count.toLocaleString("fa-IR")})
                </button>
              ))}
            </div>
            <label>
              جست‌وجوی کاربر
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(0);
                }}
              />
            </label>
          </div>
          {(users.error || lineFilters.error) && (
            <p className="panel-pad" role="alert">
              {users.error || lineFilters.error}
            </p>
          )}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>کاربر</th>
                  <th>نقش</th>
                  <th>واحد</th>
                  <th>محدودیت دسترسی</th>
                  <th>وضعیت</th>
                  {manage && <th>عملیات</th>}
                </tr>
              </thead>
              <tbody>
                {users.data.data.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <div className="toolbar user-cell">
                        <span className="avatar" aria-hidden="true">
                          {user.name
                            .split(/\s+/)
                            .slice(0, 2)
                            .map((name) => name[0])
                            .join("‌")}
                        </span>
                        <div>
                          <strong>{user.name}</strong>
                          <br />
                          <small dir="ltr">{user.username}</small>
                        </div>
                      </div>
                    </td>
                    <td>
                      {roles.find((role) => role._id === user.roleId)?.name ??
                        user.roleId}
                    </td>
                    <td>{user.unit || "—"}</td>
                    <td>
                      {user.organizationWide
                        ? "کل سازمان"
                        : user.scopes.length.toLocaleString("fa") + " محدوده"}
                    </td>
                    <td>
                      <span className={user.active ? "badge active" : "badge"}>
                        {user.active ? "فعال" : "غیرفعال"}
                      </span>
                    </td>
                    {manage && (
                      <td>
                        {user.id !== profile.id &&
                          assignable.some(
                            (role) => role._id === user.roleId,
                          ) && (
                            <button onClick={() => setEditor(user)}>
                              ویرایش
                            </button>
                          )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {users.loading ? (
            <p className="panel-pad" role="status">
              در حال دریافت…
            </p>
          ) : (
            !users.data.count && <p className="panel-pad">کاربری پیدا نشد.</p>
          )}
          <Pagination page={page} count={users.data.count} onPage={setPage} />
        </section>
      ) : catalogue.loading && !roles.length ? (
        <p role="status">در حال دریافت نقش‌ها…</p>
      ) : (
        <RoleEditor
          catalogue={catalogue.data}
          editable={administrator}
          onSaved={() => setRevision((value) => value + 1)}
        />
      )}
      {editor !== undefined && (
        <UserEditor
          user={editor}
          roles={assignable}
          onClose={() => setEditor(undefined)}
          onDone={() => {
            setEditor(undefined);
            setRevision((value) => value + 1);
          }}
        />
      )}
    </>
  );
}
