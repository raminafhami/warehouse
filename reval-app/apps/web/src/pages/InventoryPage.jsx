import { openPrintPreview } from "../components/PrintPreview.jsx";
import { useState } from "react";
import { Pagination } from "../components/Pagination.jsx";
import { StatusStrip } from "../components/StatusStrip.jsx";
import { useResource } from "../components/useResource.js";
import { InventoryAction } from "../inventory/InventoryAction.jsx";
import { accountLabels, clock } from "../inventory/api.js";
import { errorMessage, request } from "../request/identity.js";

/** @typedef {import("../inventory/api.js").Balance} Balance */
/** @typedef {import("../inventory/api.js").Pallet} Pallet */
/** @typedef {import("../inventory/api.js").Summary} Summary */
/** @typedef {import("../inventory/api.js").Movement} Movement */
/** @typedef {import("../inventory/InventoryAction.jsx").Action} Action */
/** @typedef {import("../handover/api.js").Item} Custody */
/** @typedef {Custody & {stockSource: "custody"}} CartonCustody */
/** @typedef {{id:string,code:string,description:string,warehouseId:string,quantity:string,sourceCarton?:string,locationName?:string}} WarehouseStock */
/** @typedef {""|"materials"|"quarantine"|"defects"|"finished"} WarehouseView */
const warehouseViews = /** @type {const} */ ([
  ["", "همهٔ موجودی"],
  ["materials", "انبار مواد اولیه"],
  ["quarantine", "قرنطینه"],
  ["defects", "انبار معیوبی"],
  ["finished", "انبار محصول نهایی"],
]);
const tabs = [
  ["map", "نقشهٔ جانمایی"],
  ["balances", "کارتن‌ها"],
  ["summary", "خلاصهٔ قطعه و تأمین‌کننده"],
  ["pallets", "پالت‌ها و جانمایی"],
  ["custody", "در راه و در خط"],
  ["ledger", "تاریخچهٔ گردش"],
  ["adjustments", "اصلاحات موجودی"],
];
const empty =
  /** @type {{data:(Balance|Pallet|Summary|Movement|Custody|CartonCustody|WarehouseStock)[],count:number}} */ ({
    data: [],
    count: 0,
  });
const none = /** @type {import("../inventory/api.js").Choice[]} */ ([]);
const balanceAccounts = ["receiving", "storage", "quarantine"];
const cartonAccounts = [...balanceAccounts, "transit", "production"];

/** @param {{profile:import("../request/identity.js").Profile}} props */
export function InventoryPage({ profile }) {
  const [tab, setTab] = useState("map");
  const [zone, setZone] = useState(/** @type {WarehouseView} */ (""));
  const [page, setPage] = useState(0);
  const [warehouse, setWarehouse] = useState("");
  const [location, setLocation] = useState("");
  const [account, setAccount] = useState("");
  const [search, setSearch] = useState("");
  const [revision, setRevision] = useState(0);
  const [action, setAction] = useState(/** @type {Action|null} */ (null));
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const options = useResource("/inventory/options?map=true", none, revision);
  const warehouses = options.data.filter((item) => item.kind === "warehouses");
  const warehouseChoices =
    zone === "finished"
      ? warehouses.filter((item) => item.purpose === "finished")
      : warehouses;
  const locations = options.data.filter((item) => item.kind === "locations");
  const mapLocations = locations.filter(
    (item) => !warehouse || item.parentId === warehouse,
  );
  const zones = /** @type {Map<string, typeof mapLocations>} */ (new Map());
  for (const item of mapLocations) {
    const name = item.code.split("-")[0];
    const slots = zones.get(name) ?? [];
    slots.push(item);
    zones.set(name, slots);
  }
  const ledger = tab === "ledger" || tab === "adjustments";
  const cartons = tab === "balances";
  const specializedStock = zone === "defects" || zone === "finished";
  const selectedAccount =
    cartons || balanceAccounts.includes(account) ? account : "";
  const inventoryQuery = new URLSearchParams({ page: String(page) });
  if (warehouse) inventoryQuery.set("warehouseId", warehouse);
  if (!ledger && search) inventoryQuery.set("q", search);
  if (tab === "map") {
    inventoryQuery.set("account", "storage");
    if (location) inventoryQuery.set("locationId", location);
  } else if (zone === "quarantine") {
    inventoryQuery.set("account", "quarantine");
  } else if (
    !specializedStock &&
    (cartons || tab === "summary") &&
    selectedAccount
  ) {
    inventoryQuery.set("account", selectedAccount);
  }
  if (zone === "materials") inventoryQuery.set("zone", zone);
  if (tab === "adjustments") inventoryQuery.set("adjustments", "true");
  const path = ledger
    ? "ledger"
    : tab === "map"
      ? "balances"
      : specializedStock
        ? "warehouse-stock/" + zone
        : cartons
          ? "carton-stock"
          : tab;
  const entries = useResource(
    "/inventory/" + path + "?" + inventoryQuery,
    empty,
    revision,
  );
  const canMove = profile.permissions.includes("inventory:transfer");
  const canAdjust =
    profile.roleId === "whManager" &&
    profile.permissions.includes("inventory:edit");
  const canPrint =
    profile.permissions.includes("inventory:pdf") &&
    (!specializedStock || profile.permissions.includes(zone + ":pdf"));

  async function print() {
    try {
      await request(
        "/inventory/" +
          path +
          (specializedStock ? "?print=true&" : "/export?") +
          inventoryQuery,
      );
      openPrintPreview();
    } catch (error) {
      setError(errorMessage(error));
    }
  }
  /** @param {Movement} item */
  async function reverse(item) {
    try {
      /** @type {Balance} */
      const carton = await request("/inventory/cartons/" + item.cartonId);
      setAction({ kind: "reverse", carton, reversesId: item.id });
    } catch (error) {
      setError(errorMessage(error));
    }
  }

  return (
    <>
      <header className="page-header">
        <h1>موجودی، جانمایی و گردش کالا</h1>
        {canPrint && (tab === "balances" || tab === "map") && (
          <button
            disabled={entries.loading || Boolean(entries.error)}
            onClick={() => void print()}
          >
            PDF
          </button>
        )}
      </header>
      <StatusStrip
        items={[
          {
            label: "انبارهای قابل دسترسی",
            value: options.loading ? undefined : warehouses.length,
          },
          {
            label: "موقعیت‌های جانمایی",
            value: options.loading ? undefined : locations.length,
          },
          {
            label: "موقعیت‌های نمای فعلی",
            value: options.loading ? undefined : mapLocations.length,
          },
          {
            label: "رکوردهای فیلترشده",
            value: entries.loading ? undefined : entries.data.count,
          },
        ]}
      />
      <div className="chips inventory-warehouse-views" aria-label="نوع موجودی">
        {warehouseViews
          .filter(
            ([key]) =>
              (key !== "defects" && key !== "finished") ||
              profile.permissions.includes(key + ":view"),
          )
          .map(([key, label]) => (
            <button
              key={key}
              aria-pressed={zone === key}
              onClick={() => {
                setZone(key);
                setTab("balances");
                setPage(0);
                setWarehouse("");
                setLocation("");
                setAccount("");
                setError("");
                setNotice("");
              }}
            >
              {label}
            </button>
          ))}
      </div>
      <div className="tabs catalog-tabs">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            aria-pressed={tab === key}
            onClick={() => {
              setTab(key);
              if (key !== "balances") setZone("");
              setPage(0);
              setError("");
              setNotice("");
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <section className="panel">
        <div className="toolbar panel-pad">
          <label>
            {zone === "defects" ? "انبار مبدأ" : "انبار"}
            <select
              value={warehouse}
              onChange={(event) => {
                setWarehouse(event.target.value);
                setLocation("");
                setPage(0);
              }}
            >
              <option value="">همهٔ انبارهای مجاز</option>
              {warehouseChoices.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.code} · {item.name}
                </option>
              ))}
            </select>
          </label>
          {!specializedStock &&
            zone !== "quarantine" &&
            (cartons || tab === "summary") && (
              <label>
                حساب موجودی
                <select
                  value={selectedAccount}
                  onChange={(event) => {
                    setAccount(event.target.value);
                    setPage(0);
                  }}
                >
                  <option value="">همه</option>
                  {(cartons ? cartonAccounts : balanceAccounts)
                    .filter(
                      (key) => zone !== "materials" || key !== "quarantine",
                    )
                    .map((key) => (
                      <option key={key} value={key}>
                        {accountLabels[key]}
                      </option>
                    ))}
                </select>
              </label>
            )}
          {!ledger && (
            <label>
              {zone === "defects"
                ? "برچسب قطعه، کد کالا یا کارتن مبدأ"
                : zone === "finished"
                  ? "کارتن، مدل، موقعیت یا IMEI"
                  : tab === "pallets"
                    ? "پالت، تأمین‌کننده یا موقعیت"
                    : "کارتن، کد کالا یا موقعیت"}
              <input
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(0);
                }}
              />
            </label>
          )}
        </div>
        {tab === "map" && (
          <div className="panel-pad page-stack location-plan">
            <div className="toolbar">
              <h2>نقشه جانمایی</h2>
              <button
                aria-pressed={!location}
                onClick={() => {
                  setLocation("");
                  setPage(0);
                }}
              >
                همهٔ موقعیت‌ها
              </button>
            </div>
            <div className="location-zones">
              {Array.from(zones.entries(), ([name, slots]) => (
                <section className="location-zone" key={name}>
                  <h3>
                    ناحیه <bdi>{name}</bdi>
                  </h3>
                  <div className="location-map">
                    {slots.map((item) => (
                      <button
                        key={item.id}
                        aria-pressed={location === item.id}
                        className={
                          item.placement?.cartons ? "occupied" : undefined
                        }
                        onClick={() => {
                          setLocation(item.id);
                          setPage(0);
                        }}
                      >
                        <bdi>{item.code}</bdi>
                        <small>
                          {item.placement?.cartons ? (
                            <>
                              <bdi>{item.placement.skuCode ?? "—"}</bdi>
                              {item.placement.cartons > 1 &&
                                " +" +
                                  (item.placement.cartons - 1).toLocaleString(
                                    "fa-IR",
                                  )}
                            </>
                          ) : (
                            "خالی"
                          )}
                        </small>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>
        )}
        {(error || options.error || entries.error) && (
          <p className="panel-pad" role="alert">
            {error || options.error || entries.error}
          </p>
        )}
        {notice && (
          <p className="panel-pad" role="status">
            {notice}
          </p>
        )}
        {entries.loading ? (
          <p className="panel-pad" role="status">
            در حال دریافت موجودی…
          </p>
        ) : !entries.data.count && !entries.error ? (
          <p className="panel-pad">رکوردی پیدا نشد.</p>
        ) : (
          <div className="table-scroll">
            {ledger ? (
              <History
                rows={/** @type {Movement[]} */ (entries.data.data)}
                onReverse={
                  tab === "adjustments" && canAdjust
                    ? (item) => void reverse(item)
                    : undefined
                }
              />
            ) : tab === "summary" ? (
              <SummaryTable
                rows={/** @type {Summary[]} */ (entries.data.data)}
              />
            ) : specializedStock ? (
              <WarehouseStockTable
                rows={/** @type {WarehouseStock[]} */ (entries.data.data)}
                defects={zone === "defects"}
                warehouses={warehouses}
              />
            ) : cartons ? (
              <CartonStockTables
                rows={
                  /** @type {(Balance | CartonCustody)[]} */ (entries.data.data)
                }
                onAction={setAction}
                canMove={canMove}
                canAdjust={canAdjust}
              />
            ) : tab === "custody" ? (
              <CustodyTable
                rows={
                  /** @type {import("../handover/api.js").Item[]} */ (
                    entries.data.data
                  )
                }
              />
            ) : tab === "pallets" ? (
              <PalletTable
                rows={/** @type {Pallet[]} */ (entries.data.data)}
                onMove={
                  canMove
                    ? (pallet) => setAction({ kind: "pallet", pallet })
                    : undefined
                }
              />
            ) : (
              <CartonTable
                rows={/** @type {Balance[]} */ (entries.data.data)}
                onAction={(item) => setAction(item)}
                canMove={canMove}
                canAdjust={canAdjust}
              />
            )}
          </div>
        )}
        <Pagination page={page} count={entries.data.count} onPage={setPage} />
      </section>
      {action && (
        <InventoryAction
          action={action}
          locations={locations}
          onClose={() => setAction(null)}
          onSaved={() => {
            setAction(null);
            setRevision((value) => value + 1);
            setError("");
            setNotice("عملیات موجودی ثبت شد.");
          }}
        />
      )}
    </>
  );
}

/** @param {{rows:WarehouseStock[],defects:boolean,warehouses:import("../inventory/api.js").Choice[]}} props */
function WarehouseStockTable({ rows, defects, warehouses }) {
  const names = new Map(
    warehouses.map((warehouse) => [warehouse.id, warehouse.name]),
  );
  return (
    <table>
      <thead>
        <tr>
          <th>{defects ? "برچسب قطعه" : "کارتن محصول"}</th>
          <th>{defects ? "کد کالا" : "مدل"}</th>
          <th>{defects ? "انبار مبدأ" : "انبار"}</th>
          <th>{defects ? "کارتن مبدأ" : "موقعیت"}</th>
          <th>{defects ? "مقدار" : "تعداد گوشی"}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td>
              <bdi>{row.code}</bdi>
            </td>
            <td>{row.description}</td>
            <td>{names.get(row.warehouseId) ?? "—"}</td>
            <td>{(defects ? row.sourceCarton : row.locationName) ?? "—"}</td>
            <td>{row.quantity}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** @param {{rows:(Balance | CartonCustody)[],onAction:(action:Action)=>void,canMove:boolean,canAdjust:boolean}} props */
function CartonStockTables({ rows, ...actions }) {
  const balances = rows.filter((row) => "account" in row);
  const custody = rows.filter((row) => "stockSource" in row);
  return (
    <>
      {balances.length > 0 && <CartonTable rows={balances} {...actions} />}
      {custody.length > 0 && <CustodyTable rows={custody} />}
    </>
  );
}

/** @param {{rows:Custody[]}} props */
function CustodyTable({ rows }) {
  return (
    <table>
      <thead>
        <tr>
          <th>کارتن مبدأ</th>
          <th>کالا</th>
          <th>خط</th>
          <th>در راه</th>
          <th>در خط</th>
          <th>در سبد</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td>
              <bdi>{row.cartonCode}</bdi>
            </td>
            <td>
              <bdi>{row.skuCode}</bdi>
            </td>
            <td>{row.lineName}</td>
            <td>{row.transit}</td>
            <td>{row.line}</td>
            <td>{row.basket}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** @param {{rows:Balance[],onAction:(action:Action)=>void,canMove:boolean,canAdjust:boolean}} props */
function CartonTable({ rows, onAction, canMove, canAdjust }) {
  return (
    <table>
      <thead>
        <tr>
          <th>کارتن</th>
          <th>کد کالا</th>
          <th>تأمین‌کننده</th>
          <th>موقعیت</th>
          <th>مانده</th>
          <th>رزرو</th>
          <th>آزاد</th>
          <th>عملیات</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((carton) => (
          <tr key={carton.id}>
            <td>
              <bdi>{carton.cartonCode}</bdi>
            </td>
            <td>
              <bdi>{carton.skuCode}</bdi>
            </td>
            <td>{carton.supplierName}</td>
            <td>{carton.locationCode ?? accountLabels[carton.account]}</td>
            <td>{carton.quantity}</td>
            <td>{carton.reserved}</td>
            <td>{carton.available}</td>
            <td>
              <div className="toolbar">
                {canMove && carton.account !== "quarantine" && (
                  <button onClick={() => onAction({ kind: "move", carton })}>
                    جانمایی / انتقال
                  </button>
                )}
                {canMove && carton.account === "storage" && (
                  <button onClick={() => onAction({ kind: "reserve", carton })}>
                    رزرو
                  </button>
                )}
                {canAdjust && (
                  <button onClick={() => onAction({ kind: "adjust", carton })}>
                    اصلاح
                  </button>
                )}
                <button onClick={() => onAction({ kind: "inspect", carton })}>
                  تطبیق
                </button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** @param {{rows:Pallet[],onMove?:(pallet:Pallet)=>void}} props */
function PalletTable({ rows, onMove }) {
  return (
    <table>
      <thead>
        <tr>
          <th>پالت</th>
          <th>تأمین‌کننده</th>
          <th>کارتن</th>
          <th>موقعیت</th>
          {onMove && <th>عملیات</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((item) => (
          <tr key={item.id}>
            <td>
              <bdi>{item.code}</bdi>
            </td>
            <td>{item.source}</td>
            <td>{item.cartonCount.toLocaleString("fa")}</td>
            <td>
              {item.locations
                .map((value) => accountLabels[value] ?? value)
                .join("، ")}
            </td>
            {onMove && (
              <td>
                {item.hasQuarantine ? (
                  "دارای کارتن قرنطینه"
                ) : (
                  <button onClick={() => onMove(item)}>انتقال پالت</button>
                )}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** @param {{rows:Summary[]}} props */
function SummaryTable({ rows }) {
  return (
    <table>
      <thead>
        <tr>
          <th>کد کالا</th>
          <th>تأمین‌کننده</th>
          <th>محل دریافت</th>
          <th>جانمایی‌شده</th>
          <th>قرنطینه</th>
          <th>رزرو</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((item) => (
          <tr key={item.skuId + ":" + item.supplierId}>
            <td>
              <bdi>{item.skuCode}</bdi>
            </td>
            <td>{item.supplierName}</td>
            <td>{item.receiving}</td>
            <td>{item.storage}</td>
            <td>{item.quarantine}</td>
            <td>{item.reserved}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** @param {{rows:Movement[],onReverse?:(item:Movement)=>void}} props */
function History({ rows, onReverse }) {
  return (
    <table>
      <thead>
        <tr>
          <th>تاریخ</th>
          <th>سند</th>
          <th>مبدأ</th>
          <th>مقصد</th>
          <th>مقدار</th>
          <th>علت</th>
          {onReverse && <th>عملیات</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((item) => (
          <tr key={item.id}>
            <td>{clock.format(new Date(item.at))}</td>
            <td>
              <bdi>{item.documentId}</bdi>
            </td>
            <td>{item.fromLocationCode ?? accountLabels[item.from]}</td>
            <td>{item.toLocationCode ?? accountLabels[item.to]}</td>
            <td>{item.quantity}</td>
            <td>{item.reason || "—"}</td>
            {onReverse && (
              <td>
                {item.reversed ? (
                  "جبران‌شده"
                ) : item.reversesId ? (
                  "سند جبرانی"
                ) : (
                  <button onClick={() => onReverse(item)}>اصلاح جبرانی</button>
                )}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
