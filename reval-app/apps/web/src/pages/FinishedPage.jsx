import { openPrintPreview } from "../components/PrintPreview.jsx";
import { useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { BarcodeLabel } from "../components/BarcodeLabel.jsx";
import { FormDialog } from "../components/FormDialog.jsx";
import { Pagination } from "../components/Pagination.jsx";
import { StatusStrip } from "../components/StatusStrip.jsx";
import { useResource } from "../components/useResource.js";
import { errorMessage } from "../request/identity.js";
import { useCommand } from "../request/useCommand.js";

const tabs = {
  packing: "کارتن‌بندی ۹تایی",
  stock: "موجودی",
  placement: "جانمایی انبار",
};
const statuses = { open: "باز", closed: "بسته", placed: "جانمایی‌شده" };
/** @typedef {{id:string,code:string,modelName:string,colorName:string,capacity:number,version:number,members:{unitId:string,unitCode:string,numbers:string[]}[],status:keyof typeof statuses,labelVersion?:number,locationName?:string}} Carton */
/** @typedef {{id:string,name:string}} Option */

/** @param {{done:(id:string)=>void,close:()=>void}} props */
function NewCarton({ done, close }) {
  const options = useResource(
    "/finished/options",
    /** @type {{warehouses:(Option&{canCreate:boolean})[],models:(Option&{colorIds:string[]})[],colors:Option[]}} */ ({
      warehouses: [],
      models: [],
      colors: [],
    }),
    0,
  );
  const [model, setModel] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const command = useCommand();
  const colorIds =
    options.data.models.find((row) => row.id === model)?.colorIds ?? [];
  return (
    <FormDialog title="کارتن ۹تایی جدید" onClose={close}>
      <form
        className="page-stack"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            /** @type {Carton} */
            const row = await command(
              "/finished/cartons",
              Object.fromEntries(new FormData(event.currentTarget)),
            );
            done(row.id);
          } catch (error) {
            setError(errorMessage(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          انبار محصول{" "}
          <select name="warehouseId" required>
            <option value="">انتخاب کنید</option>
            {options.data.warehouses
              .filter((row) => row.canCreate)
              .map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          مدل{" "}
          <select
            name="modelId"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            required
          >
            <option value="">انتخاب کنید</option>
            {options.data.models.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          رنگ{" "}
          <select key={model} name="colorId" required>
            <option value="">انتخاب کنید</option>
            {options.data.colors
              .filter((row) => colorIds.includes(row.id))
              .map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
          </select>
        </label>
        {(error || options.error) && (
          <p role="alert">{error || options.error}</p>
        )}
        {!options.loading &&
          !options.data.warehouses.some((row) => row.canCreate) && (
            <p>انبار محصول مجاز تعریف نشده است.</p>
          )}
        <div className="toolbar">
          <button disabled={busy || options.loading}>ایجاد کارتن</button>
          <button type="button" onClick={close}>
            بستن
          </button>
        </div>
      </form>
    </FormDialog>
  );
}

/** @param {{canCreate:boolean}} props */
export function FinishedPage({ canCreate }) {
  const [tab, setTab] = useState(/** @type {keyof typeof tabs} */ ("packing")),
    [by, setBy] = useState("code"),
    [query, setQuery] = useState(""),
    [page, setPage] = useState(0),
    [open, setOpen] = useState(false);
  const [params, setParams] = useSearchParams();
  const [revision, reload] = useState(0);
  const navigate = useNavigate();
  const record = useResource(
    "/finished/cartons?" +
      new URLSearchParams({ tab, by, q: query, page: String(page) }),
    /** @type {{items:Carton[],count:number,canPrint:boolean}} */ ({
      items: [],
      count: 0,
      canPrint: false,
    }),
    revision,
  );
  const selectedId = params.get("carton") ?? record.data.items[0]?.id;
  return (
    <div className="page-stack">
      <h1>انبار محصول نهایی</h1>
      <StatusStrip
        items={[
          {
            label: "کارتن‌های فیلترشده",
            value: record.loading ? undefined : record.data.count,
          },
          ...Object.entries(statuses).map(([key, label]) => ({
            label,
            value: record.loading
              ? undefined
              : record.data.items.filter((row) => row.status === key).length,
            hint: "در این صفحه",
          })),
        ]}
      />
      <div className="tabs">
        {Object.entries(tabs).map(([key, label]) => (
          <button
            key={key}
            aria-pressed={key === tab}
            onClick={() => {
              setTab(/** @type {keyof typeof tabs} */ (key));
              setParams({});
              setPage(0);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className={tab === "packing" ? "split-detail" : undefined}>
        <section className="panel panel-pad page-stack">
          <h2>{tabs[tab]}</h2>
          <div className="toolbar">
            <label>
              جستجو بر اساس{" "}
              <select
                value={by}
                onChange={(event) => {
                  setBy(event.target.value);
                  setPage(0);
                }}
              >
                <option value="code">کارتن</option>
                <option value="imei">IMEI</option>
              </select>
            </label>
            <label>
              عبارت جستجو{" "}
              <input
                dir="ltr"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(0);
                }}
              />
            </label>
            {tab === "packing" && canCreate && (
              <button onClick={() => setOpen(true)}>کارتن ۹تایی جدید</button>
            )}
            {tab === "stock" && record.data.canPrint && (
              <button onClick={() => openPrintPreview()}>
                PDF موجودی محصول
              </button>
            )}
          </div>
          {record.error && <p role="alert">{record.error}</p>}
          {!record.loading && !record.data.count && <p>کارتنی پیدا نشد.</p>}
          {tab === "packing" && (
            <ul className="record-list">
              {record.data.items.map((row) => (
                <li key={row.id}>
                  <Link
                    to={"?carton=" + row.id}
                    aria-current={selectedId === row.id ? "true" : undefined}
                  >
                    <bdi>{row.code}</bdi>
                    <span className="badge">
                      {row.members.length.toLocaleString("fa-IR")} از{" "}
                      {row.capacity.toLocaleString("fa-IR")}
                    </span>
                    <small>
                      {row.modelName} · {row.colorName}
                    </small>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {tab !== "packing" && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>کارتن</th>
                    <th>مدل و رنگ</th>
                    <th>تعداد</th>
                    <th>وضعیت</th>
                    <th>موقعیت</th>
                  </tr>
                </thead>
                <tbody>
                  {record.data.items.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <Link to={"/finished/cartons/" + row.id}>
                          {row.code}
                        </Link>
                      </td>
                      <td>
                        {row.modelName} · {row.colorName}
                      </td>
                      <td>
                        {row.members.length} / {row.capacity}
                      </td>
                      <td>{statuses[row.status]}</td>
                      <td>{row.locationName ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pagination page={page} count={record.data.count} onPage={setPage} />
        </section>
        {tab === "packing" &&
          (selectedId ? (
            <CartonDetail
              key={selectedId}
              selectedId={selectedId}
              onUpdated={() => reload((value) => value + 1)}
            />
          ) : (
            <section className="panel detail-placeholder">
              {record.loading
                ? "در حال دریافت کارتن‌ها…"
                : "برای اسکن جعبه‌ها یک کارتن را انتخاب یا ایجاد کنید."}
            </section>
          ))}
      </div>
      {open && (
        <NewCarton
          close={() => setOpen(false)}
          done={(id) => navigate("/finished/cartons/" + id)}
        />
      )}
    </div>
  );
}

/** @param {{selectedId?:string,onUpdated?:()=>void}} props */
export function CartonDetail({ selectedId, onUpdated }) {
  const { id: routeId } = useParams();
  const path = "/finished/cartons/" + (selectedId ?? routeId);
  const [revision, reload] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [preview, setPreview] = useState(false),
    [placing, setPlacing] = useState(false);
  const command = useCommand();
  const {
    data,
    error: loadError,
    loading,
  } = useResource(
    path,
    /** @type {{carton:Carton,locations:(Option&{code:string})[],access:Record<"scan"|"remove"|"label"|"close"|"place",boolean>}|null} */ (
      null
    ),
    revision,
  );
  if (!data)
    return (
      <p role={loadError ? "alert" : "status"}>
        {loadError || "در حال دریافت کارتن…"}
      </p>
    );
  const { carton, access, locations } = data,
    blocked = busy || loading;
  /** @param {string} action @param {object} values */
  async function save(action, values) {
    if (blocked) return false;
    setBusy(true);
    setError("");
    try {
      await command(path + "/" + action, {
        version: carton.version,
        ...values,
      });
      reload((value) => value + 1);
      onUpdated?.();
      return true;
    } catch (error) {
      setError(errorMessage(error));
      return false;
    } finally {
      setBusy(false);
    }
  }
  /** @param {string} action @param {import("react").FormEvent<HTMLFormElement>} event */
  async function submit(action, event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (await save(action, Object.fromEntries(new FormData(form)))) {
      form.reset();
      if (action === "place") setPlacing(false);
    }
  }
  const open = carton.status === "open",
    full = carton.members.length === carton.capacity;
  return (
    <div className="page-stack">
      <h1>کارتن محصول · {carton.code}</h1>
      {!selectedId && <Link to="/finished">انبار محصول</Link>}
      <section className="panel panel-pad page-stack">
        <p>
          {carton.modelName} · {carton.colorName} · {statuses[carton.status]} ·{" "}
          {carton.members.length} از {carton.capacity}
        </p>
        {carton.locationName && <p>موقعیت فعلی {carton.locationName}</p>}
        {(error || loadError) && !placing && (
          <p role="alert">{error || loadError}</p>
        )}
        {open && access.scan && (
          <form
            className="toolbar"
            onSubmit={(event) => void submit("scan", event)}
          >
            <label>
              بارکد جعبهٔ گوشی <input name="code" required dir="ltr" />
            </label>
            <button disabled={blocked || full}>افزودن به کارتن</button>
          </form>
        )}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>گوشی</th>
                <th>IMEI</th>
                {open && access.remove && <th>عملیات</th>}
              </tr>
            </thead>
            <tbody>
              {carton.members.map((row) => (
                <tr key={row.unitId}>
                  <td>{row.unitCode}</td>
                  <td dir="ltr">{row.numbers.join(" / ")}</td>
                  {open && access.remove && (
                    <td>
                      <button
                        disabled={blocked}
                        onClick={() =>
                          void save("remove", { unitId: row.unitId })
                        }
                      >
                        خارج کردن
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {access.label && (carton.labelVersion || (open && full)) && (
          <button
            disabled={blocked}
            onClick={async () => {
              if (carton.labelVersion || (await save("label", {})))
                setPreview(true);
            }}
          >
            {carton.labelVersion
              ? "نمایش و چاپ مجدد برچسب کارتن"
              : "صدور و چاپ برچسب کارتن"}
          </button>
        )}
        {open && access.close && carton.labelVersion && (
          <form
            className="toolbar"
            onSubmit={(event) => void submit("close", event)}
          >
            <label>
              اسکن برچسب کارتن <input required name="code" dir="ltr" />
            </label>
            <button disabled={blocked}>بستن کارتن</button>
          </form>
        )}
        {!open && access.place && (
          <button onClick={() => setPlacing(true)}>
            {carton.status === "placed" ? "جابه‌جایی کارتن" : "جانمایی کارتن"}
          </button>
        )}
      </section>
      {placing && (
        <FormDialog
          title={
            (carton.status === "placed" ? "جابه‌جایی " : "جانمایی ") +
            carton.code
          }
          onClose={() => setPlacing(false)}
        >
          <form
            className="page-stack"
            onSubmit={(event) => void submit("place", event)}
          >
            <label>
              موقعیت مقصد{" "}
              <select name="locationId" required>
                <option value="">انتخاب کنید</option>
                {locations.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name} · {row.code}
                  </option>
                ))}
              </select>
            </label>
            <label>
              اسکن موقعیت <input required name="code" dir="ltr" />
            </label>
            {error && <p role="alert">{error}</p>}
            <div className="toolbar">
              <button disabled={blocked}>ثبت موقعیت</button>
              <button type="button" onClick={() => setPlacing(false)}>
                بستن
              </button>
            </div>
          </form>
        </FormDialog>
      )}
      {preview && carton.labelVersion && (
        <BarcodeLabel
          title="برچسب کارتن محصول"
          code={carton.code}
          src={"/api/v1" + path + "/label"}
          onClose={() => setPreview(false)}
        />
      )}
    </div>
  );
}
