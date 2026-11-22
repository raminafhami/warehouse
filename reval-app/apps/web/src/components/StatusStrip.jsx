const fa = new Intl.NumberFormat("fa-IR");

/** @param {{items:{label:string,value:number|string|undefined,hint?:string}[]}} props */
export function StatusStrip({ items }) {
  return (
    <dl className="panel status-strip">
      {items.map(({ label, value, hint }) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>
            {typeof value === "number" ? fa.format(value) : (value ?? "—")}
          </dd>
          {hint && <dd className="status-hint">{hint}</dd>}
        </div>
      ))}
    </dl>
  );
}
