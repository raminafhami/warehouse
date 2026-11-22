import { openPrintPreview } from "../components/PrintPreview.jsx";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Pagination } from "../components/Pagination.jsx";
import { useResource } from "../components/useResource.js";
import { errorMessage, request } from "../request/identity.js";
import { dateLabel, statusLabels } from "../shipments/api.js";
import { ShipmentEditor } from "../shipments/ShipmentEditor.jsx";

const empty =
  /** @type {{data:import("../shipments/api.js").Shipment[],count:number}} */ ({
    data: [],
    count: 0,
  });

/** @param {{profile:import("../request/identity.js").Profile}} props */
export function ShipmentsPage({ profile }) {
  const navigate = useNavigate();
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [editor, setEditor] = useState(false);
  const [error, setError] = useState("");
  const query = new URLSearchParams({ status, q: search, page: String(page) });
  const shipments = useResource("/shipments?" + query, empty, 0);

  async function print() {
    try {
      await request("/shipments/export?" + query);
      openPrintPreview();
    } catch (error) {
      setError(errorMessage(error));
    }
  }
  return (
    <>
      <header className="page-header">
        <h1>تأمین‌کنندگان و محموله‌ها</h1>
        <div className="toolbar">
          {profile.permissions.includes("shipments:pdf") && (
            <button
              disabled={shipments.loading || Boolean(shipments.error)}
              onClick={() => void print()}
            >
              PDF
            </button>
          )}
          {profile.permissions.includes("shipments:create") && (
            <button className="primary" onClick={() => setEditor(true)}>
              ثبت محموله جدید
            </button>
          )}
        </div>
      </header>
      <section className="panel">
        <div className="panel-heading">
          <h2>محموله‌ها</h2>
          <div className="chips" aria-label="وضعیت محموله">
            {Object.entries({ "": "همه", ...statusLabels }).map(
              ([key, label]) => (
                <button
                  key={key}
                  aria-pressed={status === key}
                  onClick={() => {
                    setStatus(key);
                    setPage(0);
                  }}
                >
                  {label}
                </button>
              ),
            )}
          </div>
        </div>
        <div className="toolbar panel-pad">
          <label>
            جست‌وجوی محموله
            <input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(0);
              }}
            />
          </label>
        </div>
        {(error || shipments.error) && (
          <p role="alert" className="panel-pad">
            {error || shipments.error}
          </p>
        )}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>شمارهٔ محموله</th>
                <th>تأمین‌کننده</th>
                <th>انبار</th>
                <th>تاریخ ورود</th>
                <th>بارنامه / سفارش خرید</th>
                <th>پالت</th>
                <th>کارتن ثبت‌شده / بارنامه</th>
                <th>وضعیت</th>
              </tr>
            </thead>
            <tbody>
              {shipments.data.data.map((item) => (
                <tr key={item.id}>
                  <td>
                    <Link to={"/shipments/" + item.id} dir="ltr">
                      {item.code}
                    </Link>
                  </td>
                  <td>{item.supplierName}</td>
                  <td>{item.warehouseName}</td>
                  <td>{dateLabel.format(new Date(item.createdAt))}</td>
                  <td>
                    {item.waybillNumber}
                    {item.purchaseOrder && " · " + item.purchaseOrder}
                  </td>
                  <td>{item.palletCount.toLocaleString("fa")}</td>
                  <td>
                    {item.scannedCartons.toLocaleString("fa")} /{" "}
                    {item.expectedCartons.toLocaleString("fa")}
                  </td>
                  <td>
                    <span
                      className={
                        item.status === "approved" ? "badge active" : "badge"
                      }
                    >
                      {statusLabels[item.status]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {shipments.loading ? (
          <p className="panel-pad" role="status">
            در حال بارگیری…
          </p>
        ) : (
          !shipments.data.count &&
          !shipments.error && <p className="panel-pad">محموله‌ای پیدا نشد.</p>
        )}
        <Pagination page={page} count={shipments.data.count} onPage={setPage} />
      </section>
      {editor && (
        <ShipmentEditor
          onClose={() => setEditor(false)}
          onCreated={(id, warning) =>
            void navigate("/shipments/" + id, { state: { warning } })
          }
        />
      )}
    </>
  );
}
