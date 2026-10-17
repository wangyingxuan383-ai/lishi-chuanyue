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
