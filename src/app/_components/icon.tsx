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
};

export function Icon({ name }: { name: keyof typeof shapes }) {
  return <svg className="ui-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{shapes[name]}</svg>;
}
