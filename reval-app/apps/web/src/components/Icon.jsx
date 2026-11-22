const shapes = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  trace: (
    <>
      <circle cx="6" cy="19" r="2.5" />
      <circle cx="18" cy="5" r="2.5" />
      <path d="M8.5 19H17a3.5 3.5 0 000-7H7a3.5 3.5 0 010-7h8.5" />
    </>
  ),
  shipments: (
    <>
      <path d="M3 6h11v10H3z" />
      <path d="M14 9h4l3 3v4h-7" />
      <circle cx="7" cy="17.5" r="1.8" />
      <circle cx="17" cy="17.5" r="1.8" />
    </>
  ),
  inventory: (
    <>
      <path d="M21 8l-9-5-9 5 9 5 9-5z" />
      <path d="M3 8v8l9 5 9-5V8" />
      <path d="M12 13v8" />
    </>
  ),
  handover: (
    <>
      <path d="M4 7h14l-3-3" />
      <path d="M20 17H6l3 3" />
    </>
  ),
  imei: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 9v6M10 9v6M13 9v6M16 9v6" />
    </>
  ),
  basket: (
    <>
      <path d="M4 10h16l-1.6 9.2a1 1 0 01-1 .8H6.6a1 1 0 01-1-.8z" />
      <path d="M8.5 10L12 4l3.5 6" />
      <path d="M9.5 14v3M14.5 14v3" />
    </>
  ),
  assembly: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
    </>
  ),
  "final-qc": (
    <>
      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
      <path d="M8.5 12l2.5 2.5 4.5-5" />
    </>
  ),
  "stage-qc": (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="M3.5 6l1.5 1.5L7.5 5M3.5 12l1.5 1.5 2.5-2.5M3.5 18l1.5 1.5 2.5-2.5" />
    </>
  ),
  defects: (
    <>
      <path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  finished: (
    <>
      <path d="M3 21V8l9-5 9 5v13" />
      <path d="M7 21v-8h10v8" />
      <path d="M7 17h10" />
    </>
  ),
  reports: (
    <>
      <path d="M6 2h9l5 5v15H6z" />
      <path d="M14 2v6h6M9 13h8M9 17h6" />
    </>
  ),
  master: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2 20c0-3.5 3-6 7-6s7 2.5 7 6" />
      <path d="M16 4.5a3.5 3.5 0 010 7M18 14c2.5.6 4 2.8 4 6" />
    </>
  ),
  audit: (
    <>
      <path d="M3 12a9 9 0 109-9 9.7 9.7 0 00-6.7 2.8L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  menu: (
    <>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </>
  ),
  bell: (
    <>
      <path d="M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.9 1.9 0 003.4 0" />
    </>
  ),
  arrow: (
    <>
      <path d="M19 12H5m7 7-7-7 7-7" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 9-9m-4 4 3 3m-6 0 2 2" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 21v-2a7 7 0 0 1 14 0v2" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M3 3l18 18M10 6.2A12 12 0 0 1 12 6c6.5 0 10 6 10 6a14 14 0 0 1-3.1 3.4M6 7.8A15 15 0 0 0 2 12s3.5 6 10 6a11 11 0 0 0 4-.7" />
    </>
  ),
  chevron: (
    <>
      <path d="m6 9 6 6 6-6" />
    </>
  ),
  exit: (
    <>
      <path d="M10 17l5-5-5-5m5 5H3m13-8h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4" />
    </>
  ),
};

/** @param {{name: keyof typeof shapes,size?:number}} props */
export function Icon({ name, size = 16 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {shapes[name]}
    </svg>
  );
}
