import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** @param {{ title: string, code: string, src: string, additional?:{code:string,src:string}[], onClose: () => void }} props */
export function BarcodeLabel({ title, code, src, additional = [], onClose }) {
  const dialog = useRef(/** @type {HTMLDialogElement | null} */ (null));
  const [loaded, setLoaded] = useState(0);
  const [error, setError] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return createPortal(
    <dialog
      className="panel editor barcode-label"
      ref={dialog}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <h2>{title}</h2>
      {[{ code, src }, ...additional].map((label) => (
        <div key={label.src}>
          <p dir="ltr">{label.code}</p>
          <img
            src={label.src}
            alt={"بارکد " + label.code}
            onLoad={() => setLoaded((value) => value + 1)}
            onError={() => setError(true)}
          />
        </div>
      ))}
      {error && <p role="alert">بارکد بارگذاری نشد.</p>}
      <div className="toolbar">
        <button
          className="primary"
          disabled={error || loaded < 1 + additional.length}
          onClick={() => window.print()}
        >
          چاپ بارکد
        </button>
        <button onClick={onClose}>بستن</button>
      </div>
    </dialog>,
    document.body,
  );
}
