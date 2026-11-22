import { useEffect, useRef } from "react";

/** @param {{title:string,onClose:()=>void,busy?:boolean,children:import("react").ReactNode}} props */
export function FormDialog({ title, onClose, busy, children }) {
  const ref = useRef(/** @type {HTMLDialogElement|null} */ (null));
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      className="panel editor"
      ref={ref}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}
