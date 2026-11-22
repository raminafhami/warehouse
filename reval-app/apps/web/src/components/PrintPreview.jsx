import { useEffect, useRef, useState } from "react";
import logo from "../assets/reval-logo.png";

const printPreviewEvent = "reval:print-preview";
const date = new Intl.DateTimeFormat("fa-IR", {
  dateStyle: "medium",
  timeZone: "Asia/Tehran",
});

export function openPrintPreview() {
  window.dispatchEvent(new Event(printPreviewEvent));
}

export function PrintPreview() {
  const dialog = useRef(/** @type {HTMLDialogElement|null} */ (null));
  const documentView = useRef(/** @type {HTMLDivElement|null} */ (null));
  const [title, setTitle] = useState("");

  useEffect(() => {
    function show() {
      const source = document.querySelector("main.content");
      const target = documentView.current;
      const modal = dialog.current;
      if (!source || !target || !modal || modal.open) return;
      setTitle(source.querySelector("h1")?.textContent?.trim() || "REVAL");
      const copy = /** @type {HTMLElement} */ (source.cloneNode(true));
      copy.className = "page-stack";
      copy
        .querySelectorAll(
          "dialog, button, input, select, textarea, .tabs, .pagination, .toolbar, .page-header, nav",
        )
        .forEach((element) => element.remove());
      for (const link of copy.querySelectorAll("a"))
        link.replaceWith(document.createTextNode(link.textContent ?? ""));
      for (const element of copy.querySelectorAll("[id]"))
        element.removeAttribute("id");
      target.replaceChildren(copy);
      modal.showModal();
    }
    window.addEventListener(printPreviewEvent, show);
    return () => window.removeEventListener(printPreviewEvent, show);
  }, []);

  return (
    <dialog
      className="panel editor print-preview"
      ref={dialog}
      aria-label="پیش‌نمایش PDF"
    >
      <header className="panel-heading">
        <h2>پیش‌نمایش PDF · {title}</h2>
      </header>
      <div className="print-preview-body">
        <article className="panel">
          <div className="panel-heading print-preview-header">
            <div>
              <strong>{title}</strong>
              <div>{date.format(new Date())}</div>
            </div>
            <img src={logo} alt="REVAL" />
          </div>
          <div className="panel-pad" ref={documentView} />
        </article>
      </div>
      <footer className="panel-heading print-preview-footer">
        <button type="button" onClick={() => dialog.current?.close()}>
          بستن
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => window.print()}
        >
          چاپ / ذخیره PDF
        </button>
      </footer>
    </dialog>
  );
}
