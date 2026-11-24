// Unified 24×24 line icon system: 1.5px stroke on a crisp 24px grid, round caps
// and joins, currentColor — sitting on the same optical baseline in every theme
// and viewport without font-dependent Unicode glyphs. Decorative only: the
// enclosing control carries the accessible name.
const PATHS = {
  back: <path d="M15 5l-7 7 7 7" />,
  forward: <path d="M9 5l7 7-7 7" />,
  "chevron-down": <path d="M6 9.5l6 6 6-6" />,
  "chevron-up": <path d="M6 14.5l6-6 6 6" />,
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.35" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.35" fill="currentColor" stroke="none" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33h.08a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51h.08a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v.08a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
    </>
  ),
  person: (
    <>
      <circle cx="12" cy="8.5" r="3.4" />
      <path d="M5.2 19.5c.8-3.4 3.5-5.2 6.8-5.2s6 1.8 6.8 5.2" />
    </>
  ),
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  minus: <path d="M5.5 12h13" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="5.5" />
      <path d="M14.6 14.6L19.5 19.5" />
    </>
  ),
  "arrow-down": <path d="M12 5v13.5M6.5 13l5.5 5.5 5.5-5.5" />,
  undo: <path d="M8.5 6.5L4.5 10.5l4 4M4.5 10.5h9a4.5 4.5 0 010 9H11" />,
  redo: <path d="M15.5 6.5l4 4-4 4M19.5 10.5h-9a4.5 4.5 0 000 9H13" />,
  refresh: (
    <>
      <path d="M19.2 12a7.2 7.2 0 11-1.9-4.9" />
      <path d="M19.5 4.5v3.8h-3.8" />
    </>
  ),
  book: (
    <>
      <path d="M12 6.5C10.3 5.3 7.8 4.8 4.5 5v13c3.3-.2 5.8.3 7.5 1.5 1.7-1.2 4.2-1.7 7.5-1.5V5c-3.3-.2-5.8.3-7.5 1.5z" />
      <path d="M12 6.5v13" />
    </>
  ),
  "book-open": (
    <>
      <path d="M12 6.2C10 4.9 7.2 4.4 3.8 4.8v12.8c3.4-.4 6.2.1 8.2 1.4 2-1.3 4.8-1.8 8.2-1.4V4.8c-3.4-.4-6.2.1-8.2 1.4z" />
      <path d="M12 6.2v12.8M6.5 8.8h3M6.5 11.8h3M14.5 8.8h3M14.5 11.8h3" />
    </>
  ),
  export: (
    <>
      <path d="M12 14.5V4.5M8 8.5l4-4 4 4" />
      <path d="M5.5 14.5V19h13v-4.5" />
    </>
  ),
  "bookmark-fill": <path d="M7 4.5h10v15l-5-3.5-5 3.5z" fill="currentColor" />,
  toc: (
    <>
      <path d="M5 7h2.5M10 7h9M5 12h2.5M10 12h9M5 17h2.5M10 17h6.5" />
    </>
  ),
  "page-turn": (
    <>
      <rect x="4.5" y="5" width="15" height="14" rx="1.8" />
      <path d="M12 5v14M14.5 10l2.2 2-2.2 2M9.5 10l-2.2 2 2.2 2" />
    </>
  ),
  "page-scroll": (
    <>
      <rect x="6" y="4.5" width="12" height="15" rx="1.8" />
      <path d="M12 8v8M9.5 10.2L12 7.8l2.5 2.4M9.5 13.8L12 16.2l2.5-2.4" />
    </>
  ),
  share: (
    <>
      <path d="M12 4v11M8 8l4-4 4 4" />
      <path d="M6 12.5V19h12v-6.5" />
    </>
  ),
  import: (
    <>
      <path d="M12 4v11M8 11l4 4 4-4" />
      <path d="M5.5 14.5V19h13v-4.5" />
    </>
  ),
  download: (
    <>
      <path d="M12 4.5v10.5M8 11l4 4 4-4" />
      <path d="M5.5 19h13" />
    </>
  ),
  external: (
    <>
      <path d="M14 5h5v5M19 5l-8.5 8.5" />
      <path d="M11 6.5H6.5A1.5 1.5 0 005 8v9.5A1.5 1.5 0 006.5 19H16a1.5 1.5 0 001.5-1.5V13" />
    </>
  ),
  send: <path d="M12 19V5.5M6 11l6-6 6 6" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />,
  play: <path d="M8.5 6.2c0-.6.65-.96 1.16-.64l8.8 5.8a.76.76 0 010 1.28l-8.8 5.8c-.51.32-1.16-.04-1.16-.64z" fill="currentColor" stroke="none" />,
  pen: (
    <>
      <path d="M5 19l1-4L15.5 5.5a2.1 2.1 0 013 3L9 18z" />
      <path d="M13.5 7.5l3 3" />
    </>
  ),
  brush: (
    <>
      <path d="M18.5 4.5l1 1-7.8 8.2-2.4-2.4z" />
      <path d="M9.3 11.3c-1.8.4-3.1 1.7-3.3 3.7-.2 1.5-1.2 2.4-2 2.8 1.5.6 3.7.5 5-.7 1.2-1.1 1.5-2.4.3-3.4" />
    </>
  ),
  highlight: (
    <>
      <path d="M14.5 5l4.5 4.5-7.5 7.5H7v-4.5z" />
      <path d="M5 19.5h14" />
    </>
  ),
  sparkle: <path d="M12 4l1.6 4.6L18 10l-4.4 1.4L12 16l-1.6-4.6L6 10l4.4-1.4zM18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />,
  expand: <path d="M14 5h5v5M10 19H5v-5M19 5l-6 6M5 19l6-6" />,
  list: (
    <>
      <circle cx="5.5" cy="7" r="1" fill="currentColor" stroke="none" />
      <circle cx="5.5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="5.5" cy="17" r="1" fill="currentColor" stroke="none" />
      <path d="M9.5 7h9.5M9.5 12h9.5M9.5 17h9.5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M12 8v4.5l3 1.8" />
    </>
  ),
  branch: (
    <>
      <circle cx="7" cy="6" r="2" />
      <circle cx="7" cy="18" r="2" />
      <circle cx="17" cy="9" r="2" />
      <path d="M7 8v8M17 11c0 3-4 3-8.3 5.6" />
    </>
  ),
  seal: (
    <>
      <rect x="5" y="5" width="14" height="14" rx="2.5" />
      <path d="M9.5 9h5M12 9v6M9.5 15h5" />
    </>
  ),
  pack: (
    <>
      <path d="M8.5 8.5c0-2.2 1.6-3.8 3.5-3.8s3.5 1.6 3.5 3.8" />
      <path d="M6 8.5h12l1 9a2 2 0 01-2 2.2H7a2 2 0 01-2-2.2z" />
      <path d="M9.5 12.5h5M12 11v3" />
    </>
  ),
  scroll: (
    <>
      <path d="M6.5 5.5a2 2 0 012-2h9a2 2 0 012 2v11a2 2 0 01-2 2h-10a2 2 0 01-2-2V7.5" />
      <path d="M8.5 3.5v13a2 2 0 01-2 2M11.5 8.5h5M11.5 12h5" />
    </>
  ),
  bookshelf: (
    <>
      <path d="M4.5 19h15" />
      <rect x="5.5" y="6" width="3.2" height="13" rx=".6" />
      <rect x="9.8" y="4.8" width="3.4" height="14.2" rx=".6" />
      <path d="M14.5 6.4l2.9-.8 2.1 12.6-2.9.8z" />
    </>
  ),
  landscape: (
    <>
      <circle cx="16.5" cy="8" r="2" />
      <path d="M3.5 18.5l5.2-6.8 3.8 4.5 3-3.7 5 6z" />
    </>
  ),
  bamboo: (
    <>
      <rect x="5.5" y="5" width="3" height="14" rx=".8" />
      <rect x="10.5" y="5" width="3" height="14" rx=".8" />
      <rect x="15.5" y="5" width="3" height="14" rx=".8" />
      <path d="M4.5 8.5h15M4.5 15.5h15" />
    </>
  ),
  columns: (
    <>
      <rect x="4.5" y="5" width="15" height="14" rx="1.8" />
      <path d="M12 5v14M7.2 9h2.5M7.2 12h2.5M14.3 9h2.5M14.3 12h2.5" />
    </>
  ),
  rows: (
    <>
      <rect x="5" y="4.5" width="14" height="15" rx="1.8" />
      <path d="M8 8.5h8M8 12h8M8 15.5h5.5" />
    </>
  ),
  compass: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M14.8 9.2l-1.8 4.6-4.6 1.8 1.8-4.6z" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M5 15V6.5A1.5 1.5 0 016.5 5H15" />
    </>
  ),
  paste: (
    <>
      <path d="M9 4.5h6v2.5H9z" />
      <path d="M9 5.5H6.5A1.5 1.5 0 005 7v11.5A1.5 1.5 0 006.5 20h11a1.5 1.5 0 001.5-1.5V7a1.5 1.5 0 00-1.5-1.5H15" />
    </>
  ),
  trash: (
    <>
      <path d="M5 7h14M9.5 7V5.2c0-.4.3-.7.7-.7h3.6c.4 0 .7.3.7.7V7" />
      <path d="M7 7l.8 11.5a1.5 1.5 0 001.5 1.5h5.4a1.5 1.5 0 001.5-1.5L17 7M10 10.5v6M14 10.5v6" />
    </>
  ),
  pushpin: (
    <>
      <path d="M9 4.5h6l-.8 4.8 2.3 2.2v1.5H7.5v-1.5l2.3-2.2z" />
      <path d="M12 13v6.5" />
    </>
  ),
  eye: (
    <>
      <path d="M3.5 12s3.2-5.5 8.5-5.5 8.5 5.5 8.5 5.5-3.2 5.5-8.5 5.5S3.5 12 3.5 12z" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  "eye-off": (
    <>
      <path d="M4.5 4.5l15 15M9.9 6.8A8.6 8.6 0 0112 6.5c5.3 0 8.5 5.5 8.5 5.5a14.4 14.4 0 01-2.8 3.4M6.6 8.8A14.2 14.2 0 003.5 12s3.2 5.5 8.5 5.5c1.4 0 2.7-.4 3.8-1" />
      <path d="M10.2 10.2a2.5 2.5 0 003.6 3.6" />
    </>
  ),
  bookmark: <path d="M7 4.5h10v15l-5-3.5-5 3.5z" />,
  memo: (
    <>
      <path d="M6 4.5h9l3 3v12H6z" />
      <path d="M14.8 4.5v3.2H18M9 11.5h6M9 15h4.5" />
    </>
  ),
  rewind: <path d="M11 7l-5 5 5 5M18 7l-5 5 5 5" />,
  people: (
    <>
      <circle cx="9" cy="9" r="3" />
      <path d="M3.5 19c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5" />
      <path d="M15.5 6.2a3 3 0 010 5.6M17 14.6c1.7.5 3 1.9 3.5 4.4" />
    </>
  ),
  flag: <path d="M6 20V4.5M6 5h10l-2 3.5 2 3.5H6" />,
  coin: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <rect x="10" y="10" width="4" height="4" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s6-5.6 6-11a6 6 0 10-12 0c0 5.4 6 11 6 11z" />
      <circle cx="12" cy="10" r="2.2" />
    </>
  ),
  heart: <path d="M12 19.5s-7-4.3-7-9.4A3.9 3.9 0 0112 8a3.9 3.9 0 017 2.1c0 5.1-7 9.4-7 9.4z" />,
  feather: (
    <>
      <path d="M19 5c-6 0-11 4.5-11 11v3" />
      <path d="M8 16c5 0 8-3 9.5-7.5M5 19l3-3" />
    </>
  ),
  hourglass: (
    <>
      <path d="M6.5 4.5h11M6.5 19.5h11" />
      <path d="M8 4.5v2.2c0 2.3 4 3.4 4 5.3s-4 3-4 5.3v2.2M16 4.5v2.2c0 2.3-4 3.4-4 5.3s4 3 4 5.3v2.2" />
    </>
  ),
  palette: (
    <>
      <path d="M12 4.5a7.5 7.5 0 100 15c1 0 1.5-.7 1.5-1.4 0-1.2-1-1.5-1-2.6 0-.9.7-1.5 1.6-1.5H16a3.5 3.5 0 003.5-3.5c0-3.4-3.4-6-7.5-6z" />
      <circle cx="8.5" cy="11" r=".9" fill="currentColor" stroke="none" />
      <circle cx="11" cy="8" r=".9" fill="currentColor" stroke="none" />
      <circle cx="15" cy="8.5" r=".9" fill="currentColor" stroke="none" />
    </>
  ),
  bell: (
    <>
      <path d="M6.5 16.5V11a5.5 5.5 0 0111 0v5.5l1.5 1.5H5z" />
      <path d="M10 20a2 2 0 004 0" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M4.5 12h15M12 4.5c2.2 2.4 2.2 12.6 0 15M12 4.5c-2.2 2.4-2.2 12.6 0 15" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="6.5" rx="6.5" ry="2.5" />
      <path d="M5.5 6.5v11c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5v-11M5.5 12c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4.5l8 14H4z" />
      <path d="M12 10v4M12 16.5h.01" />
    </>
  ),
  chat: <path d="M5 6.5h14v9H10l-4 3.5v-3.5H5z" />,
  dice: (
    <>
      <rect x="5" y="5" width="14" height="14" rx="3" />
      <circle cx="9" cy="9" r=".95" fill="currentColor" stroke="none" />
      <circle cx="15" cy="15" r=".95" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r=".95" fill="currentColor" stroke="none" />
    </>
  ),
  key: (
    <>
      <circle cx="8.5" cy="12" r="3.5" />
      <path d="M12 12h8M17 12v3M20 12v2" />
    </>
  ),
  headphones: (
    <>
      <path d="M4.5 13.5V12a7.5 7.5 0 0115 0v1.5" />
      <rect x="3.5" y="13" width="3.8" height="6" rx="1.6" />
      <rect x="16.7" y="13" width="3.8" height="6" rx="1.6" />
    </>
  ),
  pause: (
    <>
      <rect x="7" y="6" width="3.5" height="12" rx="1" fill="currentColor" stroke="none" />
      <rect x="13.5" y="6" width="3.5" height="12" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  volume: (
    <>
      <path d="M5 9.5h3.5L13 6v12l-4.5-3.5H5z" />
      <path d="M16 9.2a4.2 4.2 0 010 5.6M18.5 6.8a7.5 7.5 0 010 10.4" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4L18 18M18 6l-1.6 1.6M7.6 16.4L6 18" />
    </>
  ),
  moon: <path d="M19.5 14.5A7.5 7.5 0 019.5 4.5a7.5 7.5 0 1010 10z" />,
  sliders: (
    <>
      <path d="M4.5 7h9M17.5 7h2M4.5 12h3M11.5 12h8M4.5 17h11M19.5 17h0" />
      <circle cx="15.5" cy="7" r="2" />
      <circle cx="9.5" cy="12" r="2" />
      <circle cx="17.5" cy="17" r="2" />
    </>
  ),
  timer: (
    <>
      <path d="M9.5 3.5h5M12 3.5v2" />
      <circle cx="12" cy="13" r="7" />
      <path d="M12 9.5V13l2.5 1.8" />
    </>
  ),
  sort: <path d="M7 5v14M4 16l3 3 3-3M14 7h6M14 12h4.5M14 17h3" />,
  "pushpin-fill": (
    <>
      <path d="M9 4.5h6l-.8 4.8 2.3 2.2v1.5H7.5v-1.5l2.3-2.2z" fill="currentColor" />
      <path d="M12 13v6.5" />
    </>
  ),
  "auto-read": (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M10.2 9.2l4.8 2.8-4.8 2.8z" fill="currentColor" stroke="none" />
    </>
  ),
  "library-hall": (
    <>
      <path d="M4 9.5L12 5l8 4.5" />
      <path d="M5.5 9.5v8.5M9.8 9.5v8.5M14.2 9.5v8.5M18.5 9.5v8.5M4 18.5h16" />
    </>
  ),
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 24 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
