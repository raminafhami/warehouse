import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { basketStatus } from "../basket/api.js";
import { FormDialog } from "../components/FormDialog.jsx";
import { Pagination } from "../components/Pagination.jsx";
import { useResource } from "../components/useResource.js";
import { errorMessage } from "../request/identity.js";
import { useCommand } from "../request/useCommand.js";
import { BasketDetailPage } from "./BasketDetailPage.jsx";

const empty =
  /** @type {{data:import("../basket/api.js").Basket[],count:number}} */ ({
    data: [],
    count: 0,
  });
const noOrders = /** @type {import("../basket/api.js").OrderOption[]} */ ([]);

/** @param {{profile:import("../request/identity.js").Profile}} props */
export function BasketPage({ profile }) {
  const [params] = useSearchParams();
  const incoming =
    params.get("mode") === "incoming" ||
    !profile.permissions.includes("basket:view");
  const lineId = params.get("line") ?? "";
  return (
    <BasketList
      key={Number(incoming) + ":" + lineId}
      incoming={incoming}
      lineId={lineId}
      create={profile.permissions.includes("basket:create")}
    />
  );
}

/** @param {{incoming:boolean,create:boolean,lineId:string}} props */
function BasketList({ incoming, create, lineId }) {
  const [params, setParams] = useSearchParams();
  const [revision, reload] = useState(0);
  const [page, setPage] = useState(0);
  const [q, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [editor, setEditor] = useState(false);
  const query = new URLSearchParams({
    mode: incoming ? "incoming" : "",
    page: String(page),
    q,
    status,
    lineId,
  });
  const resource = useResource("/basket?" + query, empty, revision);
  const scopedLines = useResource(
    "/basket/lines",
    /** @type {{id:string,name:string}[]} */ ([]),
    0,
  );
  const selectedId =
    params.get("basket") ??
    resource.data.data.find(
      (row) => row.status === (incoming ? "handed_over" : "preparing"),
    )?.id;
  const lineName = scopedLines.data.find((line) => line.id === lineId)?.name;
  const navigate = useNavigate();
  const statuses = Object.entries(basketStatus).filter(
    ([id]) => !incoming || id === "handed_over" || id === "received",
  );
  return (
    <>
      <header className="page-header">
        <h1>
          {incoming ? "دریافت سبد در مونتاژ" : "آماده‌سازی سبد"}
          {lineName ? " · " + lineName : ""}
        </h1>
        {!incoming && create && (
          <button className="primary" onClick={() => setEditor(true)}>
            آماده‌سازی گوشی جدید
          </button>
        )}
      </header>
      <div className="chips basket-line-filter" aria-label="خط تولید">
        {[{ id: "", name: "همه خطوط" }, ...scopedLines.data].map((line) => (
          <button
            type="button"
            key={line.id}
            aria-pressed={line.id === lineId}
            onClick={() =>
              setParams({
                ...(incoming ? { mode: "incoming" } : {}),
                ...(line.id ? { line: line.id } : {}),
              })
            }
          >
            {line.name}
          </button>
        ))}
      </div>
      {selectedId && (
        <div className="page-stack basket-inline">
          <BasketDetailPage
            key={selectedId}
            selectedId={selectedId}
            onUpdated={() => reload((value) => value + 1)}
          />
        </div>
      )}
      <section className="panel">
        <div className="panel-heading">
          <h2>{incoming ? "صف دریافت سبدها" : "سبدهای اخیر"}</h2>
        </div>
        <div className="toolbar panel-pad">
          <label>
            جست‌وجو
            <input
              value={q}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(0);
              }}
            />
          </label>
          <label>
            وضعیت
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(0);
              }}
            >
              <option value="">همه</option>
              {statuses.map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {resource.error && (
          <p className="panel-pad" role="alert">
            {resource.error}
          </p>
        )}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>سبد</th>
                <th>گوشی</th>
                <th>دستور تولید</th>
                <th>مدل و رنگ</th>
                <th>خط</th>
                <th>وضعیت</th>
              </tr>
            </thead>
            <tbody>
              {resource.data.data.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link
                      dir="ltr"
                      to={
                        "?" +
                        new URLSearchParams({
                          ...(incoming ? { mode: "incoming" } : {}),
                          ...(lineId ? { line: lineId } : {}),
                          basket: row.id,
                        })
                      }
                      aria-current={selectedId === row.id ? "true" : undefined}
                    >
                      {row.code}
                    </Link>
                  </td>
                  <td dir="ltr">{row.unitCode}</td>
                  <td dir="ltr">{row.orderCode}</td>
                  <td>
                    {row.modelName} · {row.colorName}
                  </td>
                  <td>{row.lineName}</td>
                  <td>{basketStatus[row.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {resource.loading ? (
          <p className="panel-pad" role="status">
            در حال دریافت…
          </p>
        ) : (
          !resource.data.count && <p className="panel-pad">سبدی پیدا نشد.</p>
        )}
        <Pagination page={page} count={resource.data.count} onPage={setPage} />
      </section>
      {editor && (
        <PrepareEditor
          close={() => setEditor(false)}
          created={(id) => {
            setEditor(false);
            reload((value) => value + 1);
            void navigate(
              "?" +
                new URLSearchParams({
                  ...(lineId ? { line: lineId } : {}),
                  basket: id,
                }),
            );
          }}
        />
      )}
    </>
  );
}

/** @param {{close:()=>void,created:(id:string)=>void}} props */
function PrepareEditor({ close, created }) {
  const [query, setQuery] = useState("");
  const [orderId, setOrderId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const resource = useResource(
    "/basket/options?" + new URLSearchParams({ q: query }),
    noOrders,
    0,
  );
  const command = useCommand();
  /** @param {import("react").FormEvent<HTMLFormElement>} event */
  async function prepare(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      /** @type {import("../basket/api.js").Basket} */
      const result = await command("/basket", { orderId });
      created(result.id);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <FormDialog title="آماده‌سازی گوشی جدید" onClose={close} busy={busy}>
      <form onSubmit={prepare}>
        <label>
          جست‌وجوی دستور
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setOrderId("");
            }}
          />
        </label>
        <label>
          دستور تولید
          <select
            name="orderId"
            value={orderId}
            onChange={(event) => setOrderId(event.target.value)}
            required
          >
            <option value="">انتخاب دستور</option>
            {resource.data.map((row) => (
              <option key={row.id} value={row.id}>
                {row.code} · {row.modelName} · {row.colorName} · {row.lineName}
              </option>
            ))}
          </select>
        </label>
        {resource.loading ? (
          <p role="status">در حال دریافت دستورها…</p>
        ) : (
          !resource.data.length && (
            <p>دستور قابل تخصیصی در محدودهٔ شما پیدا نشد.</p>
          )
        )}
        {(error || resource.error) && (
          <p role="alert">{error || resource.error}</p>
        )}
        <div className="toolbar">
          <button
            className="primary"
            disabled={busy || resource.loading || !orderId}
          >
            ساخت سبد
          </button>
          <button type="button" disabled={busy} onClick={close}>
            انصراف
          </button>
        </div>
      </form>
    </FormDialog>
  );
}
