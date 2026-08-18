"use client";

import { useEffect, useRef, useState } from "react";

export function Dialog({
  title,
  children,
  onClose,
  wide = false,
  dismissOnBackdrop = true,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
  dismissOnBackdrop?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="dialog-bg" onClick={dismissOnBackdrop ? onClose : undefined}>
      <div className="dialog" style={wide ? { maxWidth: 1080, width: "100%" } : undefined} onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-3 text-base font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel = "Confirm",
  danger = false,
  onConfirm,
  onClose,
}: {
  title: string;
  body: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog title={title} onClose={onClose}>
      <div className="mb-4 text-sm" style={{ color: "var(--text-dim)" }}>{body}</div>
      <div className="flex justify-end gap-2">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className={`btn ${danger ? "danger" : "primary"}`} onClick={() => { onConfirm(); onClose(); }}>
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

export function PromptDialog({
  title,
  label,
  initial = "",
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  initial?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) { onSubmit(value.trim()); onClose(); }
        }}
      >
        <label className="mb-1 block text-xs" style={{ color: "var(--text-faint)" }}>{label}</label>
        <input ref={ref} className="input mb-4 w-full" value={value} onChange={(e) => setValue(e.target.value)} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary">OK</button>
        </div>
      </form>
    </Dialog>
  );
}
