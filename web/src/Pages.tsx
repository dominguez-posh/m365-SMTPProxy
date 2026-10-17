import { useEffect, useState, type FormEvent } from "react";
import { LuCode, LuHistory, LuKeyRound, LuPlus, LuRotateCcw, LuSearch, LuShieldOff, LuTrash2, LuUserPlus } from "react-icons/lu";
import type { ApiToken, EventEntry, Overview, User } from "../../shared/types";
import { api, fmtDate } from "./api";
import { useApp } from "./state";
import { CopyLine, Empty, Loading, Modal, Note, useConfirm } from "./ui";

export function EventsPage() {
  const [list, setList] = useState<EventEntry[]>();
  const [q, setQ] = useState("");
  useEffect(() => {
    api<EventEntry[]>("GET", "/events").then(setList);
  }, []);
  const f = q.toLowerCase();
  const rows = (list ?? []).filter((e) => !f || `${e.by} ${e.action} ${e.proxyName ?? ""} ${e.detail ?? ""}`.toLowerCase().includes(f));
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Ereignisse</h1>
          <p className="sub">Freigaben, Änderungen, Befehle, Updates und Anmeldeeinstellungen mit Person und Zeit.</p>
        </div>
        <div className="search" style={{ width: 300, maxWidth: "100%" }}>
          <LuSearch aria-hidden />
          <input className="input" placeholder="Suchen" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <div className="panel">
        {!list ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty icon={<LuHistory aria-hidden />}>Keine Ereignisse.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Zeit</th>
                  <th>Person</th>
                  <th>Proxy</th>
                  <th>Aktion</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td className="nowrap">{fmtDate(e.at)}</td>
                    <td>{e.by}</td>
                    <td>{e.proxyId ? <a href={`#/proxy/${e.proxyId}`}>{e.proxyName}</a> : <span className="faint">–</span>}</td>
                    <td>
                      <div className="t" style={{ fontWeight: 500 }}>
                        {e.action}
                      </div>
                      {e.detail && <div className="s">{e.detail}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

export function UsersPage() {
  const { user: me, toast } = useApp();
  const { ask, node } = useConfirm();
  const [list, setList] = useState<User[]>();
  const [adding, setAdding] = useState(false);
  const [pwFor, setPwFor] = useState<User | null>(null);
  const load = () => api<User[]>("GET", "/users").then(setList);
  useEffect(() => {
    load();
  }, []);
  const act = async (f: () => Promise<unknown>, ok: string) => {
    try {
      await f();
      toast(ok);
      load();
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  return (
    <>
      {node}
      <div className="page-head">
        <div>
          <h1>Benutzer</h1>
          <p className="sub">Administratoren dieses Verwaltungsservers. Jeder meldet sich mit Passwort und zweitem Faktor (Passkey oder Authenticator-App) an.</p>
        </div>
        <button className="btn primary" onClick={() => setAdding(true)}>
          <LuUserPlus aria-hidden /> Benutzer anlegen
        </button>
      </div>
      <div className="panel">
        {!list ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Benutzer</th>
                  <th>Zweiter Faktor</th>
                  <th>Letzte Anmeldung</th>
                  <th>Angelegt</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div className="t">{u.displayName}</div>
                      <div className="s">
                        {u.username}
                        {u.id === me?.id ? " · Sie" : ""}
                      </div>
                    </td>
                    <td>
                      {u.mfaEnabled ? (
                        <span className="badge ok">{[u.passkeyCount ? `${u.passkeyCount} Passkey${u.passkeyCount > 1 ? "s" : ""}` : "", u.totpEnabled ? "App" : ""].filter(Boolean).join(" + ")}</span>
                      ) : (
                        <span className="badge warn">noch nicht eingerichtet</span>
                      )}
                    </td>
                    <td className="nowrap">{fmtDate(u.lastLogin)}</td>
                    <td className="nowrap">{fmtDate(u.createdAt)}</td>
                    <td className="right">
                      {u.id !== me?.id && (
                        <div className="row" style={{ flexWrap: "nowrap", justifyContent: "flex-end" }}>
                          <button className="btn small" onClick={() => setPwFor(u)}>
                            <LuKeyRound aria-hidden /> Passwort
                          </button>
                          {u.mfaEnabled && (
                            <button
                              className="btn small"
                              onClick={async () =>
                                (await ask(`Zweiten Faktor von ${u.username} zurücksetzen? Passkeys, App und Notfallcodes werden gelöscht; bei der nächsten Anmeldung richtet ${u.username} einen neuen ein.`, { danger: true, action: "Zurücksetzen" })) &&
                                act(() => api("POST", `/users/${u.id}/reset-mfa`), "Zweiter Faktor zurückgesetzt.")
                              }
                            >
                              <LuShieldOff aria-hidden /> MFA zurücksetzen
                            </button>
                          )}
                          <button className="icon-btn" title="Löschen" aria-label="Löschen" onClick={async () => (await ask(`${u.username} löschen?`, { danger: true })) && act(() => api("DELETE", `/users/${u.id}`), "Benutzer gelöscht.")}>
                            <LuTrash2 aria-hidden />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {adding && <NewUserDialog onClose={() => setAdding(false)} onDone={() => (setAdding(false), load())} />}
      {pwFor && <PasswordDialog user={pwFor} onClose={() => setPwFor(null)} />}
    </>
  );
}

function NewUserDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { toast } = useApp();
  const [form, setForm] = useState({ username: "", displayName: "", password: "" });
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api("POST", "/users", form);
      toast(`${form.username} angelegt. Bei der ersten Anmeldung richtet der Benutzer einen zweiten Faktor ein.`);
      onDone();
    } catch (x: any) {
      setError(x.message);
    }
  };
  return (
    <Modal title="Benutzer anlegen" onClose={onClose}>
      <form onSubmit={submit}>
        {error && <Note kind="danger">{error}</Note>}
        <div className="form-2">
          <div className="field">
            <label>Benutzername</label>
            <input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoFocus required />
          </div>
          <div className="field">
            <label>Name</label>
            <input className="input" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          </div>
        </div>
        <div className="field">
          <label>Erstes Passwort (mindestens 12 Zeichen)</label>
          <input className="input" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn primary">Anlegen</button>
        </div>
      </form>
    </Modal>
  );
}

function PasswordDialog({ user, onClose }: { user?: User; onClose: () => void }) {
  const { toast } = useApp();
  const [pw, setPw] = useState({ current: "", password: "", repeat: "" });
  const [error, setError] = useState("");
  const own = !user;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pw.password !== pw.repeat) return setError("Die neuen Passwörter stimmen nicht überein.");
    try {
      await (own ? api("POST", "/auth/password", { current: pw.current, password: pw.password }) : api("POST", `/users/${user!.id}/password`, { password: pw.password }));
      toast(own ? "Passwort geändert." : `Passwort von ${user!.username} gesetzt.`);
      onClose();
    } catch (x: any) {
      setError(x.message);
    }
  };
  return (
    <Modal title={own ? "Eigenes Passwort ändern" : `Passwort für ${user!.username}`} onClose={onClose}>
      <form onSubmit={submit}>
        {error && <Note kind="danger">{error}</Note>}
        {own && (
          <div className="field">
            <label>Aktuelles Passwort</label>
            <input className="input" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoFocus required />
          </div>
        )}
        <div className="form-2">
          <div className="field">
            <label>Neues Passwort</label>
            <input className="input" type="password" autoComplete="new-password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} autoFocus={!own} required />
          </div>
          <div className="field">
            <label>Wiederholen</label>
            <input className="input" type="password" autoComplete="new-password" value={pw.repeat} onChange={(e) => setPw({ ...pw, repeat: e.target.value })} required />
          </div>
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn primary">Speichern</button>
        </div>
      </form>
    </Modal>
  );
}

export function SettingsPage() {
  const { toast } = useApp();
  const [ov, setOv] = useState<Overview>();
  const [pwOpen, setPwOpen] = useState(false);
  useEffect(() => {
    api<Overview>("GET", "/overview").then(setOv);
  }, []);
  if (!ov) return <Loading />;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Einstellungen</h1>
          <p className="sub">Server {ov.publicUrl}</p>
        </div>
        <button className="btn" onClick={() => setPwOpen(true)}>
          <LuKeyRound aria-hidden /> Eigenes Passwort ändern
        </button>
      </div>
      <div className="stack">
        <div className="panel">
          <div className="panel-head">
            <h3>Client-Paket und Updates</h3>
            <span className="muted small">
              Version <b>{ov.package?.version ?? "kein Paket"}</b>
              {ov.package && ` · gebaut ${fmtDate(ov.package.builtAt)}`}
            </span>
          </div>
          <div className="panel-pad">
            <label className="check" style={{ marginBottom: 0 }}>
              <input
                type="checkbox"
                checked={ov.autoUpdate}
                onChange={async (e) => {
                  await api("PUT", "/settings", { autoUpdate: e.target.checked });
                  setOv({ ...ov, autoUpdate: e.target.checked });
                  toast(e.target.checked ? "Neue Versionen werden automatisch verteilt." : "Updates werden nur noch gezielt ausgerollt.");
                }}
              />
              <span>
                Neue Versionen automatisch an alle freigegebenen Proxys verteilen
                <span className="help">Aus: Updates werden je Proxy oder für alle gezielt unter „Proxys“ ausgerollt. Jeder Proxy kann Updates zusätzlich lokal ablehnen.</span>
              </span>
            </label>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h3>Installation</h3>
          </div>
          <div className="panel-pad stack" style={{ gap: 12 }}>
            <div>
              <div className="label" style={{ marginBottom: 6 }}>
                Mit Anmeldung bei diesem Server (PowerShell als Administrator)
              </div>
              <CopyLine text={ov.installCommand} />
            </div>
            <div>
              <div className="label" style={{ marginBottom: 6 }}>
                Mit anderem SMTP-Port
              </div>
              <CopyLine text={`& ([scriptblock]::Create((irm ${ov.publicUrl}/install.ps1))) -Port 2525`} />
            </div>
            <div>
              <div className="label" style={{ marginBottom: 6 }}>
                Eigenständig ohne Verwaltungsserver (neuestes GitHub-Release)
              </div>
              <CopyLine text="irm https://github.com/dominguez-posh/m365-SMTPProxy/releases/latest/download/install.ps1 | iex" />
            </div>
          </div>
        </div>

        <ApiTokens publicUrl={ov.publicUrl} />
      </div>
      {pwOpen && <PasswordDialog onClose={() => setPwOpen(false)} />}
    </>
  );
}

function ApiTokens({ publicUrl }: { publicUrl: string }) {
  const { toast } = useApp();
  const { ask, node } = useConfirm();
  const [list, setList] = useState<ApiToken[]>([]);
  const [name, setName] = useState("");
  const [hours, setHours] = useState(8);
  const [created, setCreated] = useState<string | null>(null);
  const load = () => api<ApiToken[]>("GET", "/api-tokens").then(setList);
  useEffect(() => {
    load();
  }, []);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await api<ApiToken & { token: string }>("POST", "/api-tokens", { name, hours });
      setCreated(r.token);
      setName("");
      load();
    } catch (x: any) {
      toast(x.message, "error");
    }
  };
  return (
    <div className="panel">
      {node}
      <div className="panel-head">
        <h3>
          <LuCode aria-hidden /> API-Zugriff
        </h3>
        <span className="muted small">Für Fehlersuche und Automatisierung, höchstens 24 Stunden gültig</span>
      </div>
      <div className="panel-pad">
        <p className="muted small" style={{ marginTop: 0 }}>
          Ein Token handelt wie ein Administrator (Proxys, Status, Protokolle, Ereignisse, Einstellungen, Befehle, Updates, <code>/api/diagnostics</code>), aber ohne Benutzerverwaltung, API-Tokens und Anmeldung. Aufruf:{" "}
          <code>Authorization: Bearer smtpproxy_…</code> an <code>{publicUrl}/api/…</code>. Beschreibung der Endpunkte: docs/API.md im Repository.
        </p>
        {created && (
          <Note kind="warn">
            <b>Neuer Token – nur jetzt sichtbar:</b>
            <div style={{ marginTop: 8 }}>
              <CopyLine text={created} />
            </div>
          </Note>
        )}
        <form className="row" onSubmit={create} style={{ alignItems: "flex-end", marginBottom: 14 }}>
          <div className="field" style={{ flex: 1, minWidth: 200, marginBottom: 0 }}>
            <label>Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Fehlersuche mit Claude" />
          </div>
          <div className="field" style={{ width: 140, marginBottom: 0 }}>
            <label>Gültig (Stunden)</label>
            <input className="input" type="number" min={1} max={24} value={hours} onChange={(e) => setHours(Number(e.target.value))} />
          </div>
          <button className="btn primary" disabled={!name.trim() || !(hours >= 1 && hours <= 24)}>
            <LuPlus aria-hidden /> Token erzeugen
          </button>
        </form>
        {list.length === 0 ? (
          <p className="faint small" style={{ margin: 0 }}>
            Keine gültigen Tokens.
          </p>
        ) : (
          <div className="table-wrap" style={{ border: "1px solid var(--line)", borderRadius: "var(--r-m)" }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Erzeugt</th>
                  <th>Gültig bis</th>
                  <th>Zuletzt verwendet</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <div className="t">{t.name}</div>
                      <div className="s">{t.createdBy}</div>
                    </td>
                    <td className="nowrap">{fmtDate(t.createdAt)}</td>
                    <td className="nowrap">{fmtDate(t.expiresAt)}</td>
                    <td className="nowrap">{t.lastUsedAt ? `${fmtDate(t.lastUsedAt)} · ${t.lastUsedIp}` : "–"}</td>
                    <td className="right">
                      <button
                        className="btn small danger"
                        onClick={async () => {
                          if (!(await ask(`Token „${t.name}“ widerrufen?`, { danger: true, action: "Widerrufen" }))) return;
                          await api("DELETE", `/api-tokens/${t.id}`);
                          toast("Token widerrufen.");
                          load();
                        }}
                      >
                        <LuRotateCcw aria-hidden /> Widerrufen
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

