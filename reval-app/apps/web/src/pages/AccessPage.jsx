import { useEffect, useState } from "react";
import production from "../assets/login-production.webp";
import logo from "../assets/reval-logo.png";
import partner from "../assets/reval-partner.png";
import { errorMessage, request } from "../request/identity.js";
import { Icon } from "../components/Icon.jsx";
import "./AccessPage.css";

/** @param {{ change?: boolean, onComplete: () => Promise<void>, onLogout?: () => Promise<void> }} props */
export function AccessPage({ change = false, onComplete, onLogout }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [visible, setVisible] = useState(false);
  const [username, setUsername] = useState("");
  const [accounts, setAccounts] = useState(
    /** @type {{username:string,name:string,roleName:string}[]} */ ([]),
  );

  useEffect(() => {
    if (change) return;
    const controller = new AbortController();
    request("/demo/accounts", { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted && Array.isArray(result))
          setAccounts(result);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [change]);

  /** @param {import("react").PointerEvent<HTMLFormElement>} event */
  function tilt(event) {
    if (
      event.pointerType !== "mouse" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const stage = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!stage) return;
    const x = (event.clientX - stage.left) / stage.width;
    const y = (event.clientY - stage.top) / stage.height;
    const { style } = event.currentTarget;
    style.setProperty("--rx", `${(0.5 - y) * 10}deg`);
    style.setProperty("--ry", `${(x - 0.5) * 10}deg`);
    style.setProperty("--gx", `${x * 100}%`);
    style.setProperty("--gy", `${y * 100}%`);
  }

  /** @param {import("react").FormEvent<HTMLFormElement>} event */
  async function submit(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      const password = form.get("password");
      if (change && form.get("confirmation") !== password) {
        setError("تکرار رمز با رمز جدید یکسان نیست.");
        return;
      }
      if (change)
        await request("/auth/password", {
          method: "POST",
          body: {
            currentPassword: form.get("currentPassword"),
            newPassword: password,
          },
        });
      else
        await request("/auth/login", {
          method: "POST",
          body: { username: form.get("username"), password },
        });
      await onComplete();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <div className="login-bg" aria-hidden="true">
        <i className="lg-orb a" />
        <i className="lg-orb b" />
        <i className="lg-orb c" />
        <img className="lg-line" src={production} alt="" />
      </div>
      <div className="login-stage">
        <form
          className="login-card"
          onSubmit={submit}
          onPointerMove={tilt}
          onPointerLeave={(event) => {
            for (const name of ["--rx", "--ry", "--gx", "--gy"])
              event.currentTarget.style.removeProperty(name);
          }}
        >
          <div className="lc-glare" aria-hidden="true" />
          <div className="lc-head">
            <img className="lc-logo" src={logo} alt="REVAL" />
            <p>
              {change
                ? "تغییر رمز اولیه"
                : "سامانه یکپارچه انبار، تولید و رهگیری"}
            </p>
          </div>
          {!change && accounts.length > 0 && (
            <label className="lc-field">
              <span>نقش</span>
              <select
                aria-label="نقش"
                value={
                  accounts.some((entry) => entry.username === username)
                    ? username
                    : ""
                }
                onChange={(event) => setUsername(event.target.value)}
              >
                <option value="">ورود با نام کاربری</option>
                {accounts.map((entry) => (
                  <option key={entry.username} value={entry.username}>
                    {entry.roleName} · {entry.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {change ? (
            <label className="lc-field">
              <span>رمز فعلی</span>
              <span className="lc-input">
                <Icon name="key" />
                <input
                  name="currentPassword"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </span>
            </label>
          ) : (
            <label className="lc-field">
              <span>نام کاربری</span>
              <span className="lc-input">
                <Icon name="user" />
                <input
                  name="username"
                  dir="ltr"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  required
                />
              </span>
            </label>
          )}
          <div className="lc-field">
            <label htmlFor="access-password">
              {change ? "رمز جدید" : "رمز عبور"}
            </label>
            <div className="lc-input">
              <Icon name="key" />
              <input
                id="access-password"
                name="password"
                type={visible ? "text" : "password"}
                dir="ltr"
                autoComplete={change ? "new-password" : "current-password"}
                minLength={change ? 12 : undefined}
                required
              />
              <button
                type="button"
                className="lc-eye"
                aria-label={visible ? "پنهان کردن رمز عبور" : "نمایش رمز عبور"}
                aria-pressed={visible}
                onClick={() => setVisible(!visible)}
              >
                <Icon name={visible ? "eyeOff" : "eye"} />
              </button>
            </div>
          </div>
          {change && (
            <label className="lc-field">
              <span>تکرار رمز جدید</span>
              <span className="lc-input">
                <Icon name="key" />
                <input
                  name="confirmation"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  required
                />
              </span>
            </label>
          )}
          {error && <p role="alert">{error}</p>}
          <button className="lc-submit" disabled={busy}>
            {change ? "ذخیرهٔ رمز" : "ورود به سامانه"} <Icon name="arrow" />
          </button>
          {change && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void onLogout?.()}
            >
              خروج
            </button>
          )}
          <footer className="lc-foot">
            <span className="lc-company">
              <span
                style={{ maskImage: `url(${partner})` }}
                role="img"
                aria-label="جاوید رایان تجارت پارس"
              />
            </span>
            <small>نسخه ۱٫۰</small>
          </footer>
        </form>
      </div>
    </main>
  );
}
