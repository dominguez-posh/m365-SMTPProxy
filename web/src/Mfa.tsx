// Second factor of the sign-in (from hrdnr): authenticator app (TOTP) or passkey. Code or passkey after the password,
// setup with QR code or passkey, recovery codes, management of the own factors.
import { useEffect, useState, type FormEvent } from "react";
import qrcode from "qrcode-generator";
import { LuCheck, LuCloud, LuCopy, LuDownload, LuKeyRound, LuLock, LuPencil, LuPlus, LuShieldCheck, LuSmartphone, LuTrash2 } from "react-icons/lu";
import type { PasskeyInfo } from "../../shared/types";
import { fmtDate } from "./api";
import { mfa, useApp } from "./state";
import { BrandMark, BrandText, Modal, Note } from "./ui";
import { passkeySupported } from "./webauthn";

function defaultPasskeyName() {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "";
  return os ? `Passkey ${os}` : "Passkey";
}

export function LoginBrand() {
  return (
    <div className="login-brand">
      <BrandMark />
      <BrandText />
    </div>
  );
}

/** QR code as SVG (no image data, no external service) */
export function QrCode({ text, size = 208 }: { text: string; size?: number }) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet},${r + quiet}h1v1h-1z`;
  const total = n + quiet * 2;
  return (
    <svg className="qr" width={size} height={size} viewBox={`0 0 ${total} ${total}`} role="img" aria-label="QR-Code" shapeRendering="crispEdges">
      <rect width={total} height={total} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

const group = (s: string) => s.replace(/(.{4})/g, "$1 ").trim();

/** recovery codes: shown once, to download or copy */
export function RecoveryCodes({ codes, username }: { codes: string[]; username: string }) {
  const [copied, setCopied] = useState(false);
  const text = `M365 SMTP Proxy – Notfallcodes für ${username} (erzeugt ${new Date().toLocaleString("de-DE")})\n\n${codes.join("\n")}\n\nJeder Code gilt einmal. Sicher aufbewahren und nicht weitergeben.\n`;
  const download = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    a.download = `smtpproxy-notfallcodes-${username}.txt`.replace(/[^\w.@-]+/g, "_");
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div>
      <ul className="rc-grid" aria-label="Notfallcodes">
        {codes.map((c) => (
          <li key={c} className="mono">
            {c}
          </li>
        ))}
      </ul>
      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <button type="button" className="btn small" onClick={download}>
          <LuDownload aria-hidden /> Als Datei speichern
        </button>
        <button
          type="button"
          className="btn small"
          onClick={() =>
            navigator.clipboard?.writeText(codes.join("\n")).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? <LuCheck aria-hidden /> : <LuCopy aria-hidden />} {copied ? "Kopiert" : "Kopieren"}
        </button>
      </div>
    </div>
  );
}

/** end of a setup: success, and the recovery codes if the server created new ones */
function SetupDone({ codes, done, onDone }: { codes?: string[]; done: string; onDone: () => void }) {
  const { user } = useApp();
  const [saved, setSaved] = useState(false);
  return (
    <div>
      <Note kind="ok">{done}</Note>
      {codes?.length ? (
        <>
          <h3 style={{ margin: "12px 0 4px" }}>Notfallcodes</h3>
          <p className="muted small" style={{ marginTop: 0 }}>
            Mit diesen Codes melden Sie sich an, wenn Smartphone oder Passkey nicht verfügbar sind. Jeder Code gilt einmal. Sie werden nur jetzt angezeigt – bitte herunterladen oder kopieren und sicher aufbewahren.
          </p>
          <RecoveryCodes codes={codes} username={user?.username ?? ""} />
          <label className="check" style={{ marginTop: 14 }}>
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> <span>Ich habe die Notfallcodes gespeichert.</span>
          </label>
        </>
      ) : null}
      <button className="btn primary big full" style={{ marginTop: 12 }} disabled={!!codes?.length && !saved} onClick={onDone}>
        Weiter
      </button>
    </div>
  );
}

/** setup of the authenticator app: QR code or secret, first code, then recovery codes */
export function MfaSetup({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const [info, setInfo] = useState<{ secret: string; uri: string; issuer: string; account: string } | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ codes?: string[] } | null>(null);
  useEffect(() => {
    mfa.setup().then(setInfo, (e) => setError((e as Error).message));
  }, []);
  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await mfa.confirm(code);
      setResult({ codes: r.recoveryCodes });
    } catch (err) {
      setError((err as Error).message);
      setCode("");
    } finally {
      setBusy(false);
    }
  };
  if (result) return <SetupDone codes={result.codes} done="Die Authenticator-App ist eingerichtet." onDone={onDone} />;
  return (
    <form onSubmit={confirm}>
      <ol className="mfa-steps">
        <li>Eine Authenticator-App öffnen, z. B. Microsoft Authenticator, Google Authenticator, Authy oder einen Passwort-Manager mit TOTP.</li>
        <li>
          Den QR-Code scannen – oder den Schlüssel von Hand eingeben.
          <div className="mfa-qr">{info ? <QrCode text={info.uri} /> : <span className="spinner" />}</div>
          <button type="button" className="btn ghost small" onClick={() => setShowSecret(!showSecret)}>
            {showSecret ? "Schlüssel ausblenden" : "QR-Code lässt sich nicht scannen? Schlüssel anzeigen"}
          </button>
          {showSecret && info && (
            <div className="mfa-secret">
              <div className="mono">{group(info.secret)}</div>
              <div className="faint small">
                In der App „Konto hinzufügen“ → „Schlüssel eingeben“, Konto: {info.issuer}: {info.account}, zeitbasiert, 6 Stellen, 30 Sekunden.
              </div>
              <button type="button" className="btn small" onClick={() => navigator.clipboard?.writeText(info.secret)}>
                <LuCopy aria-hidden /> Schlüssel kopieren
              </button>
            </div>
          )}
        </li>
        <li>
          Den 6-stelligen Code eingeben, den die App anzeigt.
          <div className="field" style={{ marginTop: 6 }}>
            <input className="input mfa-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} aria-label="6-stelliger Code" aria-invalid={!!error} autoFocus />
            {error && (
              <span className="err" role="alert">
                {error}
              </span>
            )}
          </div>
        </li>
      </ol>
      <button className="btn primary big full" type="submit" disabled={busy || !info || code.replace(/\s/g, "").length !== 6}>
        {busy ? <span className="spinner" /> : <LuShieldCheck aria-hidden />} Code prüfen und einrichten
      </button>
      {onCancel && (
        <button type="button" className="btn ghost full" style={{ marginTop: 8 }} onClick={onCancel}>
          Abbrechen
        </button>
      )}
    </form>
  );
}

/** passkey setup: name, then the browser dialog (Windows Hello, Touch ID, phone, security key) */
export function PasskeySetup({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const [name, setName] = useState(defaultPasskeyName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ codes?: string[]; discoverable?: boolean } | null>(null);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await mfa.registerPasskey(name.trim());
      setResult({ codes: r.recoveryCodes, discoverable: r.user.passkeys.at(-1)?.discoverable });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (result)
    return (
      <SetupDone
        codes={result.codes}
        done={result.discoverable === false ? "Der Passkey ist als zweiter Faktor eingerichtet. Dieser Schlüssel speichert keine Anmeldedaten – die Anmeldung ohne Passwort ist damit nicht möglich." : "Der Passkey ist eingerichtet. Sie können sich damit künftig auch ohne Passwort anmelden."}
        onDone={onDone}
      />
    );
  return (
    <form onSubmit={create}>
      <p className="muted small" style={{ marginTop: 0 }}>
        Vergeben Sie einen Namen, an dem Sie den Passkey wiedererkennen (z. B. „YubiKey Büro“ oder „Windows Hello Laptop“). Danach fragt der Browser nach dem Gerät.
      </p>
      <div className="field">
        <label htmlFor="pk-name">Name des Passkeys</label>
        <input id="pk-name" className="input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="YubiKey 5 NFC" />
        {error && (
          <span className="err" role="alert">
            {error}
          </span>
        )}
      </div>
      <button className="btn primary big full" type="submit" disabled={busy || !name.trim()}>
        {busy ? <span className="spinner" /> : <LuKeyRound aria-hidden />} Passkey erstellen
      </button>
      {onCancel && (
        <button type="button" className="btn ghost full" style={{ marginTop: 8 }} onClick={onCancel}>
          Abbrechen
        </button>
      )}
    </form>
  );
}

function FactorChoice({ onPick }: { onPick: (m: "app" | "passkey") => void }) {
  return (
    <div className="mfa-choice">
      <button type="button" className="mfa-option" onClick={() => onPick("passkey")}>
        <LuKeyRound aria-hidden />
        <span>
          <strong>Passkey oder Sicherheitsschlüssel</strong>
          <span className="muted small">Windows Hello, Touch ID / Face ID, Smartphone oder FIDO2-Stick. Phishing-resistent und ermöglicht die Anmeldung ohne Passwort.</span>
        </span>
      </button>
      <button type="button" className="mfa-option" onClick={() => onPick("app")}>
        <LuSmartphone aria-hidden />
        <span>
          <strong>Authenticator-App</strong>
          <span className="muted small">6-stelliger Code aus Microsoft Authenticator, Google Authenticator, Authy oder einem Passwort-Manager.</span>
        </span>
      </button>
    </div>
  );
}

/** full-screen step after the password: set up a second factor (first sign-in or after a reset) */
export function MfaForcedSetup() {
  const { logout, refreshUser, user } = useApp();
  const pk = passkeySupported();
  const [method, setMethod] = useState<"app" | "passkey" | null>(pk ? null : "app");
  return (
    <div className="login-shell">
      <div className="login-card mfa-card">
        <LoginBrand />
        <h1>Zweiten Faktor einrichten</h1>
        <p className="muted">Hallo {user?.displayName}, zum Schutz des Verwaltungsservers ist ein zweiter Faktor nötig: ein Passkey oder eine Authenticator-App. Das dauert etwa eine Minute.</p>
        {method === null ? (
          <FactorChoice onPick={setMethod} />
        ) : method === "passkey" ? (
          <PasskeySetup onDone={() => refreshUser()} onCancel={() => setMethod(null)} />
        ) : (
          <MfaSetup onDone={() => refreshUser()} onCancel={pk ? () => setMethod(null) : undefined} />
        )}
        <button className="btn ghost full" style={{ marginTop: 12 }} onClick={() => logout()}>
          Abmelden
        </button>
      </div>
    </div>
  );
}

/** full-screen step after the password: passkey, code of the authenticator or a recovery code */
export function MfaVerify() {
  const { logout, setUser, user } = useApp();
  const pkAvailable = passkeySupported() && (user?.passkeys.length ?? 0) > 0;
  const appAvailable = !!user?.totpEnabled;
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (f: () => Promise<any>) => {
    setBusy(true);
    setError(null);
    try {
      setUser(await f());
    } catch (err) {
      setError((err as Error).message);
      setCode("");
    } finally {
      setBusy(false);
    }
  };
  const valid = recovery ? code.replace(/[^A-Za-z0-9]/g, "").length === 10 : code.replace(/\s/g, "").length === 6;
  const showForm = recovery || appAvailable;
  const intro = recovery
    ? "bitte einen Ihrer Notfallcodes eingeben. Jeder Code gilt nur einmal."
    : appAvailable && pkAvailable
      ? "bitte mit Ihrem Passkey bestätigen oder den aktuellen Code der Authenticator-App eingeben."
      : pkAvailable
        ? "bitte mit Ihrem Passkey oder Sicherheitsschlüssel bestätigen."
        : "bitte den aktuellen Code aus Ihrer Authenticator-App eingeben.";
  return (
    <div className="login-shell">
      <div className="login-card">
        <LoginBrand />
        <h1>Anmeldung bestätigen</h1>
        <p className="muted">
          Hallo {user?.displayName}, {intro}
        </p>
        {pkAvailable && !recovery && (
          <>
            <button type="button" className="btn primary big full" disabled={busy} onClick={() => run(mfa.verifyPasskey)}>
              {busy ? <span className="spinner" /> : <LuKeyRound aria-hidden />} Mit Passkey bestätigen
            </button>
            {!showForm && error && (
              <p className="err" role="alert">
                {error}
              </p>
            )}
            {showForm && (
              <div className="login-or">
                <span>oder</span>
              </div>
            )}
          </>
        )}
        {showForm && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run(() => mfa.verify(code.trim()));
            }}
          >
            <div className="field">
              <label htmlFor="mfa-code">{recovery ? "Notfallcode" : "6-stelliger Code"}</label>
              {recovery ? (
                <input id="mfa-code" className="input mono" autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="ABCDE-FGHJK" value={code} onChange={(e) => setCode(e.target.value)} aria-invalid={!!error} autoFocus />
              ) : (
                <input id="mfa-code" className="input mfa-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} aria-invalid={!!error} autoFocus={!pkAvailable} />
              )}
              {error && (
                <span className="err" role="alert">
                  {error}
                </span>
              )}
            </div>
            <button className={`btn ${pkAvailable && !recovery ? "" : "primary "}big full`} type="submit" disabled={!valid || busy}>
              {busy ? <span className="spinner" /> : <LuLock aria-hidden />} Bestätigen
            </button>
          </form>
        )}
        <button
          type="button"
          className="btn ghost small"
          style={{ marginTop: 10 }}
          onClick={() => {
            setRecovery(!recovery);
            setCode("");
            setError(null);
          }}
        >
          {recovery ? (appAvailable ? "Code aus der Authenticator-App verwenden" : "Passkey verwenden") : "Kein Zugriff? Notfallcode verwenden"}
        </button>
        <button className="btn ghost full" style={{ marginTop: 8 }} onClick={() => logout()}>
          Abmelden
        </button>
      </div>
    </div>
  );
}

function PasskeyRow({ k, canDelete }: { k: PasskeyInfo; canDelete: boolean }) {
  const { setUser, toast } = useApp();
  const [edit, setEdit] = useState<string | null>(null);
  const run = async (f: () => Promise<any>) => {
    try {
      setUser(await f());
      setEdit(null);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };
  return (
    <li className="pk-row">
      <LuKeyRound aria-hidden />
      <div style={{ flex: 1, minWidth: 0 }}>
        {edit !== null ? (
          <form
            className="row"
            style={{ gap: 6 }}
            onSubmit={(e) => {
              e.preventDefault();
              run(() => mfa.renamePasskey(k.id, edit));
            }}
          >
            <input className="input" style={{ minHeight: 30, flex: 1 }} maxLength={60} value={edit} onChange={(e) => setEdit(e.target.value)} autoFocus aria-label="Name des Passkeys" />
            <button className="btn small primary" type="submit" disabled={!edit.trim()}>
              Speichern
            </button>
            <button className="btn small ghost" type="button" onClick={() => setEdit(null)}>
              Abbrechen
            </button>
          </form>
        ) : (
          <strong>{k.name}</strong>
        )}
        <div className="faint small">
          angelegt {fmtDate(k.createdAt)} · {k.lastUsedAt ? `zuletzt verwendet ${fmtDate(k.lastUsedAt)}` : "noch nicht verwendet"}
          {k.backedUp && (
            <>
              {" "}
              · <LuCloud aria-hidden style={{ verticalAlign: -2 }} /> synchronisiert
            </>
          )}
          {k.discoverable === false && <> · nur als zweiter Faktor</>}
        </div>
      </div>
      {edit === null && (
        <>
          <button className="icon-btn" onClick={() => setEdit(k.name)} aria-label="Umbenennen" title="Umbenennen">
            <LuPencil aria-hidden />
          </button>
          <button
            className="icon-btn"
            disabled={!canDelete}
            onClick={() => confirm(`Passkey „${k.name}“ entfernen?`) && run(() => mfa.deletePasskey(k.id))}
            aria-label="Passkey entfernen"
            title={canDelete ? "Passkey entfernen" : "Der letzte zweite Faktor lässt sich nicht entfernen."}
          >
            <LuTrash2 aria-hidden />
          </button>
        </>
      )}
    </li>
  );
}

/** own account: authenticator app and passkeys, new recovery codes */
export function MfaDialog({ onClose }: { onClose: () => void }) {
  const { user, setUser, toast } = useApp();
  const pk = passkeySupported();
  const [mode, setMode] = useState<"status" | "codes" | "setup" | "passkey">("status");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const { refreshUser } = useApp();
  const passkeys = user?.passkeys ?? [];
  const app = !!user?.totpEnabled;
  const factors = (app ? 1 : 0) + passkeys.length;
  const regenerate = async (withPasskey = false) => {
    setBusy(true);
    setError(null);
    try {
      const r = await mfa.recoveryCodes(withPasskey ? { passkey: true } : code);
      setCodes(r.recoveryCodes);
      setUser(r.user);
    } catch (err) {
      setError((err as Error).message);
      setCode("");
    } finally {
      setBusy(false);
    }
  };
  const back = async () => {
    await refreshUser();
    setMode("status");
  };
  return (
    <Modal title="Anmeldung und zweiter Faktor" onClose={onClose}>
      {mode === "setup" ? (
        <MfaSetup onDone={back} onCancel={() => setMode("status")} />
      ) : mode === "passkey" ? (
        <PasskeySetup onDone={back} onCancel={() => setMode("status")} />
      ) : mode === "codes" ? (
        codes ? (
          <>
            <p className="muted small" style={{ marginTop: 0 }}>
              Die neuen Notfallcodes gelten ab sofort, die bisherigen sind ungültig. Bitte sicher aufbewahren – sie werden nur jetzt angezeigt.
            </p>
            <RecoveryCodes codes={codes} username={user?.username ?? ""} />
            <button className="btn primary" style={{ marginTop: 14 }} onClick={onClose}>
              Schließen
            </button>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              regenerate();
            }}
          >
            <p className="muted" style={{ marginTop: 0 }}>
              Zur Bestätigung {app ? "den aktuellen Code der Authenticator-App eingeben" : ""}
              {app && pk && passkeys.length ? " oder " : ""}
              {pk && passkeys.length ? "den Passkey verwenden" : ""}. Die bisherigen Notfallcodes werden ungültig.
            </p>
            {pk && passkeys.length > 0 && (
              <button type="button" className="btn" style={{ marginBottom: 12 }} disabled={busy} onClick={() => regenerate(true)}>
                <LuKeyRound aria-hidden /> Mit Passkey bestätigen
              </button>
            )}
            {app && (
              <div className="field">
                <label htmlFor="mfa-regen">6-stelliger Code</label>
                <input id="mfa-regen" className="input mfa-code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
              </div>
            )}
            {error && (
              <p className="err" role="alert">
                {error}
              </p>
            )}
            <div className="row" style={{ gap: 8 }}>
              {app && (
                <button className="btn primary" type="submit" disabled={busy || code.replace(/\s/g, "").length !== 6}>
                  {busy ? <span className="spinner" /> : null} Neue Notfallcodes erzeugen
                </button>
              )}
              <button type="button" className="btn ghost" onClick={() => setMode("status")}>
                Zurück
              </button>
            </div>
          </form>
        )
      ) : (
        <>
          {user?.mfaEnabled ? <Note kind="ok">Zweiter Faktor eingerichtet. {user.recoveryCodesLeft ?? 0} Notfallcodes übrig.</Note> : <Note kind="warn">Noch kein zweiter Faktor eingerichtet.</Note>}
          {user?.mfaEnabled && (user.recoveryCodesLeft ?? 0) <= 3 && <Note kind="warn">Nur noch wenige Notfallcodes übrig – bitte neue erzeugen.</Note>}
          <h3 className="mfa-h">Passkeys und Sicherheitsschlüssel</h3>
          <p className="muted small" style={{ marginTop: 0 }}>
            Passkeys sind an die Adresse dieses Servers gebunden und können nicht abgephisht werden. Auf dem Gerät gespeicherte Passkeys ermöglichen auch die Anmeldung ohne Passwort.
          </p>
          {passkeys.length > 0 && (
            <ul className="pk-list">
              {passkeys.map((k) => (
                <PasskeyRow key={k.id} k={k} canDelete={factors > 1} />
              ))}
            </ul>
          )}
          {pk && (
            <button className="btn small" onClick={() => setMode("passkey")}>
              <LuPlus aria-hidden /> Passkey hinzufügen
            </button>
          )}
          <h3 className="mfa-h">Authenticator-App</h3>
          <p className="muted small" style={{ marginTop: 0 }}>
            {app ? "Eingerichtet: Bei der Anmeldung kann der Code der App eingegeben werden." : "Nicht eingerichtet."}
          </p>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn small" onClick={() => setMode("setup")}>
              <LuSmartphone aria-hidden /> {app ? "Neues Smartphone einrichten" : "Authenticator einrichten"}
            </button>
            {app && passkeys.length > 0 && (
              <button
                className="btn small ghost"
                onClick={async () => {
                  if (!confirm("Authenticator-App entfernen? Danach melden Sie sich nur noch mit Passkey (oder Notfallcode) an.")) return;
                  try {
                    setUser(await mfa.removeTotp());
                  } catch (err) {
                    toast((err as Error).message, "error");
                  }
                }}
              >
                <LuTrash2 aria-hidden /> App entfernen
              </button>
            )}
          </div>
          <h3 className="mfa-h">Notfallcodes</h3>
          {user?.mfaEnabled && (
            <button className="btn small" onClick={() => setMode("codes")}>
              <LuShieldCheck aria-hidden /> Neue Notfallcodes erzeugen
            </button>
          )}
          <p className="faint small" style={{ marginBottom: 0, marginTop: 10 }}>
            Kein Zugriff mehr auf App, Passkey und Notfallcodes? Ein anderer Administrator kann den zweiten Faktor unter Benutzer zurücksetzen.
          </p>
        </>
      )}
    </Modal>
  );
}
