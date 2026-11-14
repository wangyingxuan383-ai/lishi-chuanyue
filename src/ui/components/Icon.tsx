// A small set of line icons (AUDIT_V4 2.5, 11.3): one 1.5px stroke on a 24px
// grid, round ends, currentColor — so they sit on the same baseline in every
// theme instead of the font-dependent ‹ ⋯ ⚙ ＋ ↓ × glyphs. Decorative only:
// the button around an icon carries the accessible name.
const PATHS = {
  back: <path d="M15 5l-7 7 7 7" />,
  forward: <path d="M9 5l7 7-7 7" />,
  more: <><circle cx="5.5" cy="12" r="1.1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" /><circle cx="18.5" cy="12" r="1.1" fill="currentColor" stroke="none" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4L18 18M6 18l1.6-1.6M16.4 7.6L18 6" /></>,
  person: <><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" /></>,
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  minus: <path d="M5.5 12h13" />,
  search: <><circle cx="10.5" cy="10.5" r="5.5" /><path d="M14.6 14.6L19.5 19.5" /></>,
  "arrow-down": <path d="M12 5v13.5M6.5 13l5.5 5.5 5.5-5.5" />,
  undo: <path d="M9 7L5 11l4 4M5 11h9a5 5 0 010 10h-2" />,
  redo: <path d="M15 7l4 4-4 4M19 11h-9a5 5 0 000 10h2" />,
  refresh: <><path d="M19 12a7 7 0 11-2.05-4.95" /><path d="M19 4.5V8h-3.5" /></>,
  book: <><path d="M12 6.5C10.3 5.3 7.8 4.8 4.5 5v13c3.3-.2 5.8.3 7.5 1.5 1.7-1.2 4.2-1.7 7.5-1.5V5c-3.3-.2-5.8.3-7.5 1.5z" /><path d="M12 6.5v13" /></>,
  share: <><path d="M12 4v11M8 8l4-4 4 4" /><path d="M6 12.5V19h12v-6.5" /></>,
  // R28 第二批: the composer, turn tools and menu items.
  send: <path d="M12 19V5.5M6 11l6-6 6 6" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />,
  play: <path d="M8.5 6v12l9.5-6z" fill="currentColor" stroke="none" />,
  pen: <><path d="M5 19l1-4L15.5 5.5a2.1 2.1 0 013 3L9 18z" /><path d="M13.5 7.5l3 3" /></>,
  sparkle: <path d="M12 4l1.6 4.6L18 10l-4.4 1.4L12 16l-1.6-4.6L6 10l4.4-1.4zM18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />,
  expand: <path d="M14 5h5v5M10 19H5v-5M19 5l-6 6M5 19l6-6" />,
  list: <path d="M9 7h10M9 12h10M9 17h10M5 7h.01M5 12h.01M5 17h.01" />,
  clock: <><circle cx="12" cy="12" r="7.5" /><path d="M12 8v4.5l3 1.8" /></>,
  branch: <><circle cx="7" cy="6" r="2" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="9" r="2" /><path d="M7 8v8M17 11c0 3-4 3-8.3 5.6" /></>,
  seal: <><rect x="5" y="5" width="14" height="14" rx="2.5" /><path d="M9.5 9h5M12 9v6M9.5 15h5" /></>,
  copy: <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M5 15V6.5A1.5 1.5 0 016.5 5H15" /></>,
  bookmark: <path d="M7 4.5h10v15l-5-3.5-5 3.5z" />,
  memo: <><path d="M6 4.5h9l3 3v12H6z" /><path d="M9 11h6M9 14.5h6" /></>,
  rewind: <path d="M11 7l-5 5 5 5M18 7l-5 5 5 5" />,
  people: <><circle cx="9" cy="9" r="3" /><path d="M3.5 19c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5" /><path d="M15.5 6.2a3 3 0 010 5.6M17 14.6c1.7.5 3 1.9 3.5 4.4" /></>,
  flag: <path d="M6 20V4.5M6 5h10l-2 3.5 2 3.5H6" />,
  coin: <><circle cx="12" cy="12" r="7.5" /><rect x="10" y="10" width="4" height="4" /></>,
  pin: <><path d="M12 21s6-5.6 6-11a6 6 0 10-12 0c0 5.4 6 11 6 11z" /><circle cx="12" cy="10" r="2.2" /></>,
  heart: <path d="M12 19.5s-7-4.3-7-9.4A3.9 3.9 0 0112 8a3.9 3.9 0 017 2.1c0 5.1-7 9.4-7 9.4z" />,
  feather: <><path d="M19 5c-6 0-11 4.5-11 11v3" /><path d="M8 16c5 0 8-3 9.5-7.5M5 19l3-3" /></>,
  hourglass: <path d="M7 4.5h10M7 19.5h10M8 4.5c0 4 8 4.5 8 7.5s-8 3.5-8 7.5M16 4.5c0 4-8 4.5-8 7.5s8 3.5 8 7.5" />,
  palette: <><path d="M12 4.5a7.5 7.5 0 100 15c1 0 1.5-.7 1.5-1.4 0-1.2-1-1.5-1-2.6 0-.9.7-1.5 1.6-1.5H16a3.5 3.5 0 003.5-3.5c0-3.4-3.4-6-7.5-6z" /><circle cx="8.5" cy="11" r=".9" fill="currentColor" stroke="none" /><circle cx="11" cy="8" r=".9" fill="currentColor" stroke="none" /><circle cx="15" cy="8.5" r=".9" fill="currentColor" stroke="none" /></>,
  bell: <><path d="M6.5 16.5V11a5.5 5.5 0 0111 0v5.5l1.5 1.5H5z" /><path d="M10 20a2 2 0 004 0" /></>,
  globe: <><circle cx="12" cy="12" r="7.5" /><path d="M4.5 12h15M12 4.5c2.2 2.4 2.2 12.6 0 15M12 4.5c-2.2 2.4-2.2 12.6 0 15" /></>,
  database: <><ellipse cx="12" cy="6.5" rx="6.5" ry="2.5" /><path d="M5.5 6.5v11c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5v-11M5.5 12c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5" /></>,
  info: <><circle cx="12" cy="12" r="7.5" /><path d="M12 11v5M12 8h.01" /></>,
  alert: <><path d="M12 4.5l8 14H4z" /><path d="M12 10v4M12 16.5h.01" /></>,
  chat: <path d="M5 6.5h14v9H10l-4 3.5v-3.5H5z" />,
  dice: <><rect x="5" y="5" width="14" height="14" rx="3" /><circle cx="9" cy="9" r=".9" fill="currentColor" stroke="none" /><circle cx="15" cy="15" r=".9" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r=".9" fill="currentColor" stroke="none" /></>,
  key: <><circle cx="8.5" cy="12" r="3.5" /><path d="M12 12h8M17 12v3M20 12v2" /></>,
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
