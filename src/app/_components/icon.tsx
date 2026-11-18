const shapes = {
  close: <path d="m6 6 12 12M18 6 6 18" />,
  more: <><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></>,
  left: <path d="m15 6-6 6 6 6" />,
  right: <path d="m9 6 6 6-6 6" />,
  down: <path d="m6 9 6 6 6-6" />,
  up: <path d="m6 15 6-6 6 6" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></>,
  tag: <><path d="M3 3h8l10 10-8 8L3 11Z" /><circle cx="7.5" cy="7.5" r=".5" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  grid: <><rect x="4" y="4" width="6" height="6" rx="1.5" /><rect x="14" y="4" width="6" height="6" rx="1.5" /><rect x="4" y="14" width="6" height="6" rx="1.5" /><rect x="14" y="14" width="6" height="6" rx="1.5" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  folder: <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2l2 2h7.8A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" />,
  queue: <><rect x="4" y="4" width="16" height="5" rx="1.5" /><path d="M4 14h16M4 19h10" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  palette: <><path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.9 1.8-1.9 0-.5-.2-.9-.5-1.3-.3-.3-.5-.8-.5-1.3 0-1 .8-1.8 1.9-1.8H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3Z" /><circle cx="7.5" cy="11" r="1" /><circle cx="10" cy="7" r="1" /><circle cx="15" cy="7.5" r="1" /></>,
  settings: <><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>,
  logout: <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />,
  image: <><rect x="3" y="4" width="18" height="16" rx="2.5" /><circle cx="9" cy="10" r="1.5" /><path d="m21 16-5-5-9 9" /></>,
  flip: <><path d="M12 3v18" strokeDasharray="2 2.5" /><path d="M9 7 4 17h5zM15 7l5 10h-5z" /></>,
  contrast: <><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" /></>,
  blur: <><circle cx="12" cy="12" r="2" /><circle cx="12" cy="12" r="5.5" opacity=".6" /><circle cx="12" cy="12" r="9" opacity=".3" /></>,
  steps: <><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M9 4v16M15 4v16" /><path d="M3 4h6v16H3z" fill="currentColor" stroke="none" opacity=".9" /><path d="M9 4h6v16H9z" fill="currentColor" stroke="none" opacity=".4" /></>,
  board: <><rect x="3" y="4" width="9" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="10" rx="1.5" /><rect x="6" y="14" width="11" height="7" rx="1.5" /></>,
  gridlines: <><rect x="3" y="3" width="18" height="18" rx="2.5" /><path d="M9 3v18M15 3v18M3 9h18M3 15h18" /></>,
};

export type IconName = keyof typeof shapes;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg className="ui-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{shapes[name]}</svg>;
}

/** refr mark: two stacked reference frames. */
export function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <rect x="7.5" y="3" width="13.5" height="13.5" rx="3" stroke="currentColor" strokeWidth="1.9" opacity=".55" />
      <rect x="3" y="7.5" width="13.5" height="13.5" rx="3" fill="currentColor" />
      <path d="m5.5 18.5 3.6-3.6 2.2 2.2 1.6-1.6 1.6 1.6" stroke="var(--accent, #000)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
