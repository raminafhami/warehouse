import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import logo from "../assets/reval-logo.png";
import partner from "../assets/reval-partner.png";
import { Icon } from "./Icon.jsx";
import { PrintPreview } from "./PrintPreview.jsx";
import { useResource } from "./useResource.js";
import "./AppShell.css";

/** @typedef {import("../request/identity.js").Profile} Profile */
/** @typedef {Parameters<typeof Icon>[0]["name"]} IconName */
/** @typedef {{icon:IconName,to:string,label:string,permission:string}} NavItem */
/** @type {{title:string,items:NavItem[]}[]} */
const navigation = [
  {
    title: "",
    items: [
      {
        icon: "dashboard",
        to: "/",
        label: "داشبورد",
        permission: "dashboard:view",
      },
      {
        icon: "trace",
        to: "/trace",
        label: "رهگیری یکپارچه",
        permission: "trace:view",
      },
    ],
  },
  {
    title: "انبار",
    items: [
      {
        icon: "shipments",
        to: "/shipments",
        label: "ورود محموله",
        permission: "shipments:view",
      },
      {
        icon: "inventory",
        to: "/inventory",
        label: "موجودی انبار",
        permission: "inventory:view",
      },
      {
        icon: "handover",
        to: "/handover",
        label: "تحویل به تولید",
        permission: "handover:view",
      },
    ],
  },
  {
    title: "تولید",
    items: [
      {
        icon: "imei",
        to: "/imei",
        label: "IMEI و برنامه تولید",
        permission: "imei:view",
      },
      {
        icon: "basket",
        to: "/basket",
        label: "آماده‌سازی سبد",
        permission: "basket:view",
      },
      {
        icon: "assembly",
        to: "/assembly",
        label: "خط مونتاژ",
        permission: "assembly:view",
      },
    ],
  },
  {
    title: "کیفیت",
    items: [
      {
        icon: "final-qc",
        to: "/final-qc",
        label: "QC نهایی و بسته‌بندی",
        permission: "finalQc:view",
      },
      {
        icon: "stage-qc",
        to: "/stage-qc",
        label: "کیفیت مرحله‌ای",
        permission: "stageQc:view",
      },
      {
        icon: "defects",
        to: "/defects",
        label: "مرجوعی‌ها",
        permission: "defects:view",
      },
    ],
  },
  {
    title: "محصولات",
    items: [
      {
        icon: "finished",
        to: "/finished",
        label: "انبار محصول",
        permission: "finished:view",
      },
    ],
  },
  {
    title: "گزارش و مدیریت",
    items: [
      {
        icon: "reports",
        to: "/reports",
        label: "گزارشات",
        permission: "reports:view",
      },
      {
        icon: "master",
        to: "/master",
        label: "اطلاعات پایه",
        permission: "master:view",
      },
      {
        icon: "users",
        to: "/users",
        label: "کاربران و دسترسی",
        permission: "users:view",
      },
      {
        icon: "audit",
        to: "/audit",
        label: "سوابق ممیزی",
        permission: "audit:view",
      },
    ],
  },
];

/** @param {Profile} profile @param {string} permission */
export function canAccess(profile, permission) {
  return (
    profile.permissions.includes(permission) &&
    (!["users:view", "audit:view"].includes(permission) ||
      profile.organizationWide)
  );
}

/** @param {Profile} profile */
export function landingPage(profile) {
  return (
    navigation
      .flatMap((group) => group.items)
      .find((item) => canAccess(profile, item.permission))?.to ?? "/account"
  );
}

/** @param {{title:string,children:import("react").ReactNode}} props */
function NavigationGroup({ title, children }) {
  const [open, setOpen] = useState(true);
  return (
    <nav className="sb-group" aria-label={title || "صفحات اصلی"}>
      {title && (
        <button
          className={open ? "sb-gbtn" : "sb-gbtn closed"}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {title}
          <Icon name="chevron" size={13} />
        </button>
      )}
      {open && children}
      {!title && <div className="sb-sep" />}
    </nav>
  );
}

/** @param {{profile:Profile, children:import("react").ReactNode, onLogout:()=>Promise<void>, onPreview:()=>void}} props */
export function AppShell({ profile, children, onLogout, onPreview }) {
  const location = useLocation();
  const [drawer, setDrawer] = useState(false);
  const [popover, setPopover] = useState(
    /** @type {""|"account"|"alerts"} */ (""),
  );
  const canDashboard = canAccess(profile, "dashboard:view");
  const { data } = useResource(
    canDashboard ? "/dashboard" : null,
    /** @type {{lines:{id:string,name:string}[],actions:{waitingBaskets:number,openDefects:number,incomingIssues:number|null,readyForFinal:number}}} */ ({
      lines: [],
      actions: {
        waitingBaskets: 0,
        openDefects: 0,
        incomingIssues: null,
        readyForFinal: 0,
      },
    }),
    0,
  );
  useEffect(() => {
    setDrawer(false);
    setPopover("");
  }, [location.key]);
  useEffect(() => {
    function closeOnEscape(/** @type {KeyboardEvent} */ event) {
      if (event.key === "Escape") {
        setDrawer(false);
        setPopover("");
      }
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, []);

  const alerts = [
    {
      to: "/shipments",
      label: "محموله با مغایرت",
      count: data.actions.incomingIssues ?? 0,
      permission: "shipments:view",
    },
    {
      to: "/basket?mode=incoming",
      label: "سبد در انتظار دریافت",
      count: data.actions.waitingBaskets,
      permission: "assembly:approve",
    },
    {
      to: "/final-qc",
      label: "در انتظار کیفیت نهایی",
      count: data.actions.readyForFinal,
      permission: "finalQc:view",
    },
    {
      to: "/defects",
      label: "پرونده خرابی باز",
      count: data.actions.openDefects,
      permission: "defects:view",
    },
  ].filter((item) => item.count > 0 && canAccess(profile, item.permission));
  const alertCount = alerts.reduce((total, item) => total + item.count, 0);
  const initials = profile.name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((name) => name[0])
    .join("‌");

  return (
    <div className="identity-shell">
      <aside
        className={drawer ? "sidebar open" : "sidebar"}
        id="main-navigation"
      >
        <div className="sb-brand">
          <Link to={landingPage(profile)}>
            <img src={logo} alt="REVAL" />
          </Link>
        </div>
        {navigation.map(({ title, items }) => {
          const allowed = items.filter(({ permission }) =>
            canAccess(profile, permission),
          );
          return (
            allowed.length > 0 && (
              <NavigationGroup key={title} title={title}>
                {allowed.map(({ icon, to, label }) => {
                  const count =
                    alerts.find((alert) => alert.to === to)?.count ?? 0;
                  const lines =
                    to === "/assembly" || to === "/basket" ? data.lines : [];
                  return (
                    <div className="nav-tree" key={to}>
                      <NavLink
                        to={to}
                        className={({ isActive }) =>
                          isActive ? "nav on" : "nav"
                        }
                        end={to === "/"}
                      >
                        <Icon name={icon} size={18} />
                        <span>{label}</span>
                        {count > 0 && (
                          <span className="count">
                            {count.toLocaleString("fa-IR")}
                          </span>
                        )}
                      </NavLink>
                      {lines.length > 0 && (
                        <div className="nav-sub">
                          {lines.map((line, index) => {
                            const current = new URLSearchParams(
                              location.search,
                            ).get("line");
                            const active =
                              location.pathname === to &&
                              (current === line.id ||
                                (!current &&
                                  to === "/assembly" &&
                                  index === 0));
                            return (
                              <Link
                                className={active ? "nav sub on" : "nav sub"}
                                aria-current={active ? "page" : undefined}
                                to={
                                  to +
                                  "?" +
                                  new URLSearchParams({ line: line.id })
                                }
                                key={line.id}
                              >
                                <i
                                  className="line-dot"
                                  style={{
                                    backgroundColor: [
                                      "#3683cf",
                                      "#de764f",
                                      "#23a77d",
                                    ][index % 3],
                                  }}
                                />
                                {line.name}
                              </Link>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
                {title === "تولید" &&
                  canAccess(profile, "assembly:approve") &&
                  !canAccess(profile, "assembly:view") && (
                    <Link className="nav" to="/basket?mode=incoming">
                      <Icon name="basket" size={18} />
                      دریافت سبد در مونتاژ
                    </Link>
                  )}
              </NavigationGroup>
            )
          );
        })}
        <footer className="sb-foot">
          <span>{profile.demo ? "نسخه نمایشی ۱٫۰" : "نسخه ۱٫۰"}</span>
          <button onClick={() => void onLogout()}>
            <Icon name="exit" /> خروج
          </button>
        </footer>
      </aside>
      {drawer && (
        <button
          className="scrim"
          aria-label="بستن منو"
          onClick={() => setDrawer(false)}
        />
      )}
      <div className="ambient" aria-hidden="true">
        <i className="amb-glow a" />
        <i className="amb-glow b" />
        <i className="amb-beam" />
      </div>
      <div className="identity-body">
        <header className="topbar">
          <button
            className="icon-btn menu-btn"
            aria-label="منو"
            aria-expanded={drawer}
            aria-controls="main-navigation"
            onClick={() => setDrawer(!drawer)}
          >
            <Icon name="menu" size={20} />
          </button>
          <span
            className="company"
            role="img"
            aria-label="جاوید رایان تجارت پارس"
          >
            <span
              className="company-ink"
              style={{ maskImage: `url(${partner})` }}
            />
          </span>
          <div className="toolbar shell-controls">
            <div className="role-sw">
              <button
                className="icon-btn"
                aria-label="هشدارها"
                aria-expanded={popover === "alerts"}
                onClick={() => setPopover(popover === "alerts" ? "" : "alerts")}
              >
                <Icon name="bell" size={20} />
                {alertCount > 0 && (
                  <span className="dot">
                    {alertCount.toLocaleString("fa-IR")}
                  </span>
                )}
              </button>
              {popover === "alerts" && (
                <div className="role-pop">
                  <div className="role-pop-head">نیازمند اقدام</div>
                  {alerts.length === 0 && (
                    <p className="panel-pad">موردی برای پیگیری وجود ندارد.</p>
                  )}
                  {alerts.map((item) => (
                    <Link className="role-item" key={item.to} to={item.to}>
                      {item.label}
                      <span className="badge">
                        {item.count.toLocaleString("fa-IR")}
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
            <div className="role-sw">
              <button
                className="role-btn"
                aria-expanded={popover === "account"}
                onClick={() =>
                  setPopover(popover === "account" ? "" : "account")
                }
              >
                <span className="avatar md" aria-hidden="true">
                  {initials}
                </span>
                <span className="who">
                  <b>{profile.name}</b>
                  <span>{profile.roleName}</span>
                </span>
                <Icon name="chevron" />
              </button>
              {popover === "account" && (
                <div className="role-pop">
                  <div className="role-pop-head">{profile.roleName}</div>
                  <Link className="role-item" to="/account">
                    حساب کاربری
                  </Link>
                  {profile.demo && (
                    <button
                      className="role-item"
                      onClick={() => {
                        setPopover("");
                        onPreview();
                      }}
                    >
                      پیش‌نمایش نقش
                    </button>
                  )}
                  <button className="role-item" onClick={() => void onLogout()}>
                    <Icon name="exit" />
                    خروج از سامانه
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>
        <main className="content">{children}</main>
        <PrintPreview />
      </div>
    </div>
  );
}
