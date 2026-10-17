// Shared UI building blocks (modelled on hrdnr): brand, notes, modal, toasts, copy line, empty state.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { LuCheck, LuCircleCheck, LuCircleX, LuCopy, LuInfo, LuMail, LuTriangleAlert, LuX } from "react-icons/lu";
import { useApp } from "./state";

export function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden>
      <LuMail />
    </span>
  );
}
export function BrandText() {
  return (
    <span className="brand-text">
      <span className="brand-name">SMTP Proxy</span>
      <span className="brand-tagline">für Microsoft 365</span>
    </span>
  );
}

export function Note({ kind = "info", children }: { kind?: "info" | "warn" | "danger" | "ok"; children: ReactNode }) {
  const Icon = kind === "ok" ? LuCircleCheck : kind === "info" ? LuInfo : LuTriangleAlert;
  return (
    <div className={`note ${kind}`}>
      <Icon aria-hidden />
      <div>{children}</div>
    </div>
  );
}

let scrollLocks = 0;
export function Modal({ title, onClose, children, foot }: { title: string; onClose: () => void; children: ReactNode; foot?: ReactNode }) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    document.addEventListener("keydown", k);
    if (scrollLocks++ === 0) document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", k);
      if (--scrollLocks === 0) document.body.style.overflow = "";
    };
  }, []);
  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Schließen">
            <LuX />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </>,
    document.body,
  );
}

/** confirmation dialog instead of window.confirm */
export function useConfirm() {
  const [state, setState] = useState<{ text: string; danger?: boolean; action?: string; resolve: (v: boolean) => void } | null>(null);
  const ask = (text: string, opts: { danger?: boolean; action?: string } = {}) => new Promise<boolean>((resolve) => setState({ text, ...opts, resolve }));
  const done = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  const node = state ? (
    <Modal
      title="Bitte bestätigen"
      onClose={() => done(false)}
      foot={
        <>
          <button className="btn" onClick={() => done(false)}>
            Abbrechen
          </button>
          <button className={state.danger ? "btn danger solid" : "btn primary"} onClick={() => done(true)}>
            {state.action ?? (state.danger ? "Löschen" : "Weiter")}
          </button>
        </>
      }
    >
      <p style={{ margin: 0 }}>{state.text}</p>
    </Modal>
  ) : null;
  return { ask, node };
}

/** small input dialog instead of window.prompt */
export function usePrompt() {
  const [state, setState] = useState<{ title: string; label: string; value: string; resolve: (v: string | null) => void } | null>(null);
  const ask = (title: string, label: string, value = "") => new Promise<string | null>((resolve) => setState({ title, label, value, resolve }));
  const done = (v: string | null) => {
    state?.resolve(v);
    setState(null);
  };
  const node = state ? (
    <Modal title={state.title} onClose={() => done(null)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (state.value.trim()) done(state.value.trim());
        }}
      >
        <div className="field">
          <label htmlFor="prompt-input">{state.label}</label>
          <input id="prompt-input" className="input" value={state.value} onChange={(e) => setState({ ...state, value: e.target.value })} autoFocus />
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={() => done(null)}>
            Abbrechen
          </button>
          <button className="btn primary" disabled={!state.value.trim()}>
            OK
          </button>
        </div>
      </form>
    </Modal>
  ) : null;
  return { ask, node };
}

export function Toasts() {
  const { toasts, dismissToast } = useApp();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((x) => (
        <div key={x.id} className={`toast ${x.kind}`}>
          {x.kind === "error" ? <LuCircleX aria-hidden /> : x.kind === "ok" ? <LuCircleCheck aria-hidden /> : <LuInfo aria-hidden />}
          <span>{x.text}</span>
          <button onClick={() => dismissToast(x.id)} aria-label="Schließen">
            <LuX />
          </button>
        </div>
      ))}
    </div>
  );
}

export function CopyLine({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="copyline">
      <code>{text}</code>
      <button
        type="button"
        onClick={() =>
          navigator.clipboard?.writeText(text).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          })
        }
      >
        {done ? <LuCheck aria-hidden /> : <LuCopy aria-hidden />} {done ? "Kopiert" : "Kopieren"}
      </button>
    </div>
  );
}

export function Empty({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <div>{children}</div>
    </div>
  );
}

export const Loading = () => (
  <div className="loading">
    <span className="spinner" /> Wird geladen …
  </div>
);
