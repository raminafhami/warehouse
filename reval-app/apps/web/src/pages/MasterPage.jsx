import { openPrintPreview } from "../components/PrintPreview.jsx";
import { useState } from "react";
import { BarcodeLabel } from "../components/BarcodeLabel.jsx";
import { groups, labels } from "../catalog/catalog.js";
import { CatalogEditor } from "../catalog/CatalogEditor.jsx";
import { Versions } from "../catalog/Versions.jsx";
import { useOptions } from "../catalog/useOptions.js";
import { Pagination } from "../components/Pagination.jsx";
import { useResource } from "../components/useResource.js";
import { errorMessage, request } from "../request/identity.js";

const empty = /** @type {import("../catalog/catalog.js").EntryList} */ ({
  data: [],
  count: 0,
});
const masterFilters = new Map([
  [
    "skus",
    {
      kind: "partTypes",
      param: "partTypeId",
      label: "نوع قطعه",
      all: "همهٔ نوع‌ها",
    },
  ],
  [
    "stations",
    { kind: "models", param: "modelId", label: "مدل گوشی", all: "همهٔ مدل‌ها" },
  ],
]);
/** @typedef {import("../catalog/catalog.js").Entry} Entry */

/** @param {{ profile: import("../request/identity.js").Profile }} props */
export function MasterPage({ profile }) {
  const [group, setGroup] = useState(0);
  const [kind, setKind] = useState("models");
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");
  const [filterId, setFilterId] = useState("");
  const [revision, setRevision] = useState(0);
  const [editor, setEditor] = useState(
    /** @type {Entry | null | undefined} */ (undefined),
  );
  const [modelId, selectModel] = useState("");
  const [label, setLabel] = useState(/** @type {Entry | null} */ (null));
  const [error, setError] = useState("");
  const filter = masterFilters.get(kind);
  const options = useOptions(filter ? [filter.kind] : [], revision, false);
  const listQuery = new URLSearchParams({ page: String(page), q: query });
  if (filter && filterId) listQuery.set(filter.param, filterId);
  const collection = useResource(
    "/master/" + kind + "?" + listQuery,
    empty,
    revision,
  );
  const model =
    kind === "models"
      ? (collection.data.data.find((entry) => entry.id === modelId) ??
        collection.data.data[0])
      : undefined;
  const createAllowed = profile.permissions.includes("master:create");
  const editAllowed = profile.permissions.includes(
    "master:" + (kind === "stations" ? "settings" : "edit"),
  );
  const printAllowed = profile.permissions.includes("master:pdf");

  /** @param {string} next */
  function selectKind(next) {
    setKind(next);
    setPage(0);
    setQuery("");
    setFilterId("");
    setError("");
    selectModel("");
  }
  /** @param {Entry} entry */
  async function toggle(entry) {
    setError("");
    try {
      await request("/master/" + kind + "/" + entry.id, {
        method: "PATCH",
        body: { version: entry.version, active: !entry.active },
      });
      setRevision((value) => value + 1);
    } catch (error) {
      setError(errorMessage(error));
    }
  }
  async function printList() {
    try {
      await request("/master/" + kind + "/export?" + listQuery);
      openPrintPreview();
    } catch (error) {
      setError(errorMessage(error));
    }
  }

  return (
    <>
      <header className="page-header">
        <h1>مدیریت اطلاعات پایه</h1>
        <div className="toolbar">
          {printAllowed && (
            <button
              disabled={collection.loading || Boolean(collection.error)}
              onClick={() => void printList()}
            >
              PDF
            </button>
          )}
          {createAllowed && (
            <button className="primary" onClick={() => setEditor(null)}>
              تعریف {labels[kind]}
            </button>
          )}
        </div>
      </header>
      <div className="tabs catalog-tabs">
        {groups.map((item, index) => (
          <button
            key={item.title}
            aria-pressed={index === group}
            onClick={() => {
              setGroup(index);
              selectKind(item.kinds[0]);
            }}
          >
            {item.title}
          </button>
        ))}
      </div>
      <div className={kind === "models" ? "split-detail" : undefined}>
        <section className="panel">
          {kind === "models" && (
            <div className="panel-heading">
              <h2>گوشی‌ها</h2>
            </div>
          )}
          <div className="toolbar panel-pad">
            {groups[group].kinds.length > 1 && (
              <label>
                نوع اطلاعات
                <select
                  value={kind}
                  onChange={(event) => selectKind(event.target.value)}
                >
                  {groups[group].kinds.map((item) => (
                    <option key={item} value={item}>
                      {labels[item]}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              جست‌وجوی نام یا کد
              <input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(0);
                }}
              />
            </label>
            {filter && (
              <label>
                {filter.label}
                <select
                  value={filterId}
                  disabled={options.loading || Boolean(options.error)}
                  onChange={(event) => {
                    setFilterId(event.target.value);
                    setPage(0);
                  }}
                >
                  <option value="">{filter.all}</option>
                  {(options.entries[filter.kind] ?? []).map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name} · {option.code}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {(error || collection.error || (filter && options.error)) && (
            <p role="alert" className="panel-pad">
              {error || collection.error || options.error}
            </p>
          )}
          {kind === "models" && (
            <ul className="record-list">
              {collection.data.data.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-pressed={model?.id === item.id}
                    onClick={() => selectModel(item.id)}
                  >
                    <strong>{item.name}</strong>
                    <small>
                      <bdi>{item.code}</bdi>
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {kind !== "models" && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>کد</th>
                    <th>نام</th>
                    <th>جزئیات</th>
                    <th>وضعیت</th>
                    <th>عملیات</th>
                  </tr>
                </thead>
                <tbody>
                  {collection.data.data.map((item) => (
                    <tr key={item.id}>
                      <td dir="ltr">{item.code}</td>
                      <td>{item.name}</td>
                      <td>
                        {kind === "skus"
                          ? item.data.specification
                          : kind === "suppliers"
                            ? item.data.country || "—"
                            : kind === "stations"
                              ? item.data.operation || "—"
                              : kind === "warehouses"
                                ? item.data.purpose || "—"
                                : "—"}
                      </td>
                      <td>
                        <span
                          className={item.active ? "badge active" : "badge"}
                        >
                          {item.active ? "فعال" : "غیرفعال"}
                        </span>
                      </td>
                      <td>
                        <div className="toolbar">
                          {kind === "stations" && editAllowed && (
                            <button onClick={() => setEditor(item)}>
                              ویرایش
                            </button>
                          )}
                          {editAllowed && (
                            <button onClick={() => void toggle(item)}>
                              {item.active ? "غیرفعال‌سازی" : "فعال‌سازی"}
                            </button>
                          )}
                          {printAllowed && (
                            <button onClick={() => setLabel(item)}>
                              بارکد
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {collection.loading ? (
            <p className="panel-pad" role="status">
              در حال دریافت…
            </p>
          ) : (
            !collection.data.count && (
              <p className="panel-pad">رکوردی پیدا نشد.</p>
            )
          )}
          <Pagination
            page={page}
            count={collection.data.count}
            onPage={setPage}
          />
        </section>
        {kind === "models" && (
          <div className="page-stack">
            {model ? (
              <>
                <section className="panel panel-pad">
                  <div className="toolbar">
                    <h2>
                      {model.name} · <bdi>{model.code}</bdi>
                    </h2>
                    <span className={model.active ? "badge active" : "badge"}>
                      {model.active ? "فعال" : "غیرفعال"}
                    </span>
                    {editAllowed && (
                      <button onClick={() => void toggle(model)}>
                        {model.active ? "غیرفعال‌سازی مدل" : "فعال‌سازی مدل"}
                      </button>
                    )}
                    {printAllowed && (
                      <button onClick={() => setLabel(model)}>بارکد</button>
                    )}
                  </div>
                  {model.data.brand && <p>برند {model.data.brand}</p>}
                </section>
                <Versions key={model.id} model={model} editable={editAllowed} />
              </>
            ) : (
              <section className="panel detail-placeholder">
                مدلی برای مشاهده فهرست قطعات ثبت نشده است.
              </section>
            )}
          </div>
        )}
      </div>
      {editor !== undefined && (
        <CatalogEditor
          kind={kind}
          entry={editor ?? undefined}
          onClose={() => setEditor(undefined)}
          onSave={() => {
            setEditor(undefined);
            setError("");
            setRevision((value) => value + 1);
          }}
        />
      )}
      {label && (
        <BarcodeLabel
          title={label.name}
          code={label.code}
          src={"/api/v1/master/" + label.kind + "/" + label.id + "/barcode"}
          onClose={() => setLabel(null)}
        />
      )}
    </>
  );
}
