import { AssemblyPage } from "./pages/AssemblyPage.jsx";
import { StationVisitPage } from "./pages/StationVisitPage.jsx";
import { DefectDetailPage } from "./pages/DefectActions.jsx";
import { DefectsPage, SupplierReturnPage } from "./pages/DefectsPage.jsx";
import {
  FinalQualityDetail,
  FinalQualityPage,
} from "./pages/FinalQualityPage.jsx";
import { CartonDetail, FinishedPage } from "./pages/FinishedPage.jsx";
import {
  ReportsPage,
  TraceDetailPage,
  TracePage,
} from "./pages/InsightsPages.jsx";
import { DashboardPage } from "./pages/DashboardPage.jsx";
import { StageQcPage } from "./pages/StageQcPage.jsx";
import { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { ReferenceDataPage } from "./pages/ReferenceDataPage.jsx";
import { AccessPage } from "./pages/AccessPage.jsx";
import { FormDialog } from "./components/FormDialog.jsx";
import { useResource } from "./components/useResource.js";
import { AuditPage } from "./pages/AuditPage.jsx";
import { MasterPage } from "./pages/MasterPage.jsx";
import { BasketPage } from "./pages/BasketPage.jsx";
import { BasketDetailPage } from "./pages/BasketDetailPage.jsx";
import { ImeiPage } from "./pages/ImeiPage.jsx";
import { ProductionOrderPage } from "./pages/ProductionOrderPage.jsx";
import { InventoryPage } from "./pages/InventoryPage.jsx";
import { HandoverPage } from "./pages/HandoverPage.jsx";
import { HandoverDetailPage } from "./pages/HandoverDetailPage.jsx";
import { ShipmentsPage } from "./pages/ShipmentsPage.jsx";
import { ShipmentDetailPage } from "./pages/ShipmentDetailPage.jsx";
import { StatusPage } from "./pages/StatusPage.jsx";
import { UsersPage } from "./pages/UsersPage.jsx";
import { errorMessage, request, RequestError } from "./request/identity.js";
import "./identity.css";
import { AppShell, landingPage } from "./components/AppShell.jsx";

/** @typedef {import("./request/identity.js").Profile} Profile */
const demoRoles = /** @type {{id:string,name:string,pages:string[]}[]} */ ([]);

/** @param {{roleId:string,onClose:()=>void}} props */
function DemoRolePreview({ roleId, onClose }) {
  const [selected, setSelected] = useState(roleId);
  const roles = useResource("/demo/roles", demoRoles, 0);
  const role = roles.data.find(({ id }) => id === selected);
  return (
    <FormDialog title="پیش‌نمایش نقش در دمو" onClose={onClose}>
      <div className="page-stack">
        <p>دسترسی نشست با نقش حساب کاربری شما تعیین می‌شود.</p>
        <label>
          نقش نمایشی
          <select
            value={selected}
            disabled={roles.loading || Boolean(roles.error)}
            onChange={(event) => setSelected(event.target.value)}
          >
            {roles.data.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {roles.loading && <p role="status">در حال دریافت نقش‌ها…</p>}
        {roles.error && <p role="alert">{roles.error}</p>}
        {role &&
          (role.pages.length ? (
            <ul aria-label="صفحه‌های نقش نمایشی">
              {role.pages.map((page) => (
                <li key={page}>{page}</li>
              ))}
            </ul>
          ) : (
            <p>این نقش مجوز مشاهدهٔ صفحه‌ای ندارد.</p>
          ))}
        <button type="button" onClick={onClose}>
          بستن
        </button>
      </div>
    </FormDialog>
  );
}

export function App() {
  const { pathname, search } = useLocation();
  const [profile, setProfile] = useState(
    /** @type {Profile | null | undefined} */ (undefined),
  );
  const [error, setError] = useState("");
  const [previewDemo, setPreviewDemo] = useState(false);

  /** @param {AbortSignal} [signal] */
  async function refresh(signal) {
    try {
      setError("");
      /** @type {Profile} */
      const user = await request("/auth/session", { signal });
      if (!signal?.aborted) setProfile(user);
    } catch (error) {
      if (signal?.aborted) return;
      if (error instanceof RequestError && error.status === 401)
        setProfile(null);
      else setError(errorMessage(error));
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const expired = () => {
      setPreviewDemo(false);
      setProfile(null);
    };
    window.addEventListener("reval:session-expired", expired);
    return () => {
      controller.abort();
      window.removeEventListener("reval:session-expired", expired);
    };
  }, []);

  async function logout() {
    try {
      await request("/auth/logout", { method: "POST" });
      setPreviewDemo(false);
      setProfile(null);
    } catch (error) {
      setError(errorMessage(error));
    }
  }

  if (error)
    return (
      <main className="access">
        <section className="panel access-card">
          <h1>REVAL</h1>
          <p role="alert">{error}</p>
          <button className="primary" onClick={() => void refresh()}>
            تلاش دوباره
          </button>
        </section>
      </main>
    );
  if (profile === undefined)
    return (
      <main className="access" role="status">
        در حال بررسی نشست…
      </main>
    );
  if (!profile)
    return (
      <Routes>
        <Route path="/login" element={<AccessPage onComplete={refresh} />} />
        <Route path="/status" element={<StatusPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  if (profile.mustChangePassword)
    return (
      <Routes>
        <Route
          path="/password"
          element={<AccessPage change onComplete={refresh} onLogout={logout} />}
        />
        <Route path="*" element={<Navigate to="/password" replace />} />
      </Routes>
    );

  const canViewUsers =
    profile.organizationWide && profile.permissions.includes("users:view");
  const canViewAudit =
    profile.organizationWide && profile.permissions.includes("audit:view");
  const canViewMaster = profile.permissions.includes("master:view");
  const canViewShipments = profile.permissions.includes("shipments:view");
  const canViewBasket = profile.permissions.includes("basket:view");
  const canViewAssembly = profile.permissions.includes("assembly:view");
  const canViewDefects = profile.permissions.includes("defects:view");
  const canViewFinal = profile.permissions.includes("finalQc:view");
  const canViewFinished = profile.permissions.includes("finished:view");
  const canViewStageQc = profile.permissions.includes("stageQc:view");
  const canReceiveBasket = profile.permissions.includes("assembly:approve");
  const canViewImei = profile.permissions.includes("imei:view");
  const canViewInventory = profile.permissions.includes("inventory:view");
  const canViewHandover = profile.permissions.includes("handover:view");
  const canDashboard = profile.permissions.includes("dashboard:view");
  const canTrace = profile.permissions.includes("trace:view");
  const canReports = profile.permissions.includes("reports:view");
  const canViewReference =
    profile.demo && profile.organizationWide && profile.roleId === "superadmin";
  const defaultPage = landingPage(profile);
  return (
    <AppShell
      profile={profile}
      onLogout={logout}
      onPreview={() => setPreviewDemo(true)}
    >
      {profile.demo && previewDemo && (
        <DemoRolePreview
          roleId={profile.roleId}
          onClose={() => setPreviewDemo(false)}
        />
      )}
      <Routes>
        <Route
          path="/account"
          element={
            <section className="panel panel-pad">
              <h1>حساب کاربری</h1>
              <p>
                {profile.name} · {profile.roleName}
              </p>
              {canViewReference && (
                <Link to="/reference-data">داده‌های نسخه مرجع</Link>
              )}
            </section>
          }
        />
        <Route
          path="/reference-data"
          element={
            canViewReference ? (
              <ReferenceDataPage />
            ) : (
              <Navigate to="/account" replace />
            )
          }
        />
        <Route
          path="/users"
          element={
            canViewUsers ? (
              <UsersPage profile={profile} />
            ) : (
              <Navigate to="/account" replace />
            )
          }
        />
        <Route
          path="/audit"
          element={
            canViewAudit ? (
              <AuditPage
                exportAllowed={profile.permissions.includes("audit:pdf")}
              />
            ) : (
              <Navigate to="/account" replace />
            )
          }
        />
        <Route
          path="/master"
          element={
            canViewMaster ? (
              <MasterPage profile={profile} />
            ) : (
              <Navigate to="/account" replace />
            )
          }
        />
        <Route
          path="/shipments"
          element={
            canViewShipments ? (
              <ShipmentsPage profile={profile} />
            ) : (
              <Navigate to="/account" replace />
            )
          }
        />
        <Route
          path="/shipments/:id"
          element={
            canViewShipments ? (
              <ShipmentDetailPage key={pathname} profile={profile} />
            ) : (
              <Navigate to="/account" replace />
            )
          }
        />
        <Route
          path="/inventory"
          element={
            canViewInventory ? (
              <InventoryPage profile={profile} />
            ) : (
              <Navigate to="/account" replace />
            )
          }
        />
        <Route
          path="/handover"
          element={
            canViewHandover ? (
              <HandoverPage profile={profile} />
            ) : (
              <Navigate to="/account" replace />
            )
          }
        />
        <Route
          path="/handover/:id"
          element={
            canViewHandover ? (
              <HandoverDetailPage key={pathname} profile={profile} />
            ) : (
              <Navigate to="/account" replace />
            )
          }
        />
        <Route
          path="/imei"
          element={
            canViewImei ? (
              <ImeiPage profile={profile} />
            ) : (
              <Navigate to="/account" replace />
            )
          }
        />
        <Route
          path="/imei/orders/:id"
          element={
            canViewImei ? (
              <ProductionOrderPage key={pathname} />
            ) : (
              <Navigate to="/account" replace />
            )
          }
        />
        <Route
          path="/basket"
          element={
            canViewBasket || canReceiveBasket ? (
              <BasketPage profile={profile} />
            ) : (
              <Navigate to="/account" replace />
            )
          }
        />
        <Route
          path="/basket/:id"
          element={
            canViewBasket || canReceiveBasket ? (
              <BasketDetailPage key={pathname} />
            ) : (
              <Navigate to="/account" replace />
            )
          }
        />
        <Route
          path="/assembly"
          element={
            canViewAssembly ? (
              <AssemblyPage
                key={new URLSearchParams(search).get("line")}
                receive={canReceiveBasket}
              />
            ) : (
              <Navigate to="/account" replace />
            )
          }
        />
        <Route
          path="/assembly/visits/:id"
          element={
            canViewAssembly || canViewStageQc ? (
              <StationVisitPage key={pathname} />
            ) : (
              <Navigate to="/account" replace />
            )
          }
        />
        <Route
          path="/stage-qc"
          element={
            canViewStageQc ? (
              <StageQcPage pdf={profile.permissions.includes("stageQc:pdf")} />
            ) : (
              <Navigate to="/account" replace />
            )
          }
        />
        <Route
          path="/stage-qc/technical"
          element={
            canViewStageQc ? (
              <DefectsPage technical />
            ) : (
              <Navigate to="/account" replace />
            )
          }
        />
        <Route
          path="/defects"
          element={
            canViewDefects ? (
              <DefectsPage permissions={profile.permissions} />
            ) : (
              <Navigate to="/account" replace />
            )
          }
        />
        <Route
          path="/defects/returns/:id"
          element={
            canViewDefects ? (
              <SupplierReturnPage key={pathname} />
            ) : (
              <Navigate to="/account" replace />
            )
          }
        />
        <Route
          path="/defects/cases/:id"
          element={
            canViewDefects || canViewAssembly || canViewStageQc ? (
              <DefectDetailPage key={pathname} />
            ) : (
              <Navigate to="/account" replace />
            )
          }
        />
        <Route
          path="/final-qc"
          element={
            canViewFinal ? (
              <FinalQualityPage />
            ) : (
              <Navigate to="/account" replace />
            )
          }
        />
        <Route
          path="/final-qc/:id"
          element={
            canViewFinal ? (
              <FinalQualityDetail key={pathname} />
            ) : (
              <Navigate to="/account" replace />
            )
          }
        />
        <Route
          path="/finished"
          element={
            canViewFinished ? (
              <FinishedPage
                canCreate={profile.permissions.includes("finished:create")}
              />
            ) : (
              <Navigate to="/account" replace />
            )
          }
        />
        <Route
          path="/finished/cartons/:id"
          element={
            canViewFinished ? (
              <CartonDetail key={pathname} />
            ) : (
              <Navigate to="/account" replace />
            )
          }
        />
        <Route
          path="/"
          element={
            canDashboard ? (
              <DashboardPage profile={profile} />
            ) : (
              <Navigate to={defaultPage} replace />
            )
          }
        />
        <Route
          path="/trace"
          element={
            canTrace ? (
              <TracePage demo={profile.demo} />
            ) : (
              <Navigate to="/account" replace />
            )
          }
        />
        <Route
          path="/trace/:kind/:id"
          element={
            canTrace ? (
              <TraceDetailPage key={pathname} />
            ) : (
              <Navigate to="/account" replace />
            )
          }
        />
        <Route
          path="/reports"
          element={
            canReports ? <ReportsPage /> : <Navigate to="/account" replace />
          }
        />
        <Route path="/status" element={<StatusPage />} />
        <Route path="*" element={<Navigate to={defaultPage} replace />} />
      </Routes>
    </AppShell>
  );
}
