import { useEffect, useState } from "react";
import type { EventEntry, Overview, User } from "../../shared/types";
import { api, fmtDate } from "./api";
import { CopyLine } from "./ProxyList";

export function EventsPage() {
  const [list, setList] = useState<EventEntry[]>([]);
  const [q, setQ] = useState("");
  useEffect(() => {
    api<EventEntry[]>("GET", "/events").then(setList);
  }, []);
  const f = q.toLowerCase();
  const rows = list.filter((e) => !f || `${e.by} ${e.action} ${e.proxyName ?? ""} ${e.detail ?? ""}`.toLowerCase().includes(f));
  return (
    <>
      <h1>Ereignisse</h1>
      <p className="sub">Freigaben, Änderungen, Befehle und Updates mit Person und Zeit.</p>
      <input placeholder="Suchen" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320, marginBottom: 12 }} />
      <div className="table-wrap">
        <table>
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
                <td style={{ whiteSpace: "nowrap" }}>{fmtDate(e.at)}</td>
                <td>{e.by}</td>
                <td>{e.proxyId ? <a href={`#/proxy/${e.proxyId}`}>{e.proxyName}</a> : "–"}</td>
                <td>
                  {e.action}
                  {e.detail && <div className="hint">{e.detail}</div>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="empty">
                  Keine Ereignisse.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function UsersPage({ me }: { me: User }) {
  const [list, setList] = useState<User[]>([]);
  const [form, setForm] = useState({ username: "", displayName: "", password: "" });
  const [error, setError] = useState("");
  const load = () => api<User[]>("GET", "/users").then(setList);
  useEffect(() => {
    load();
  }, []);
  return (
    <>
      <h1>Benutzer</h1>
      <p className="sub">Administratoren dieses Verwaltungsservers. Anmeldung mit Passwort; MFA folgt in einer späteren Version.</p>
      {error && <div className="msg err">{error}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Benutzername</th>
              <th>Name</th>
              <th>Angelegt</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((u) => (
              <tr key={u.id}>
                <td>{u.username}</td>
                <td>{u.displayName}</td>
                <td>{fmtDate(u.createdAt)}</td>
                <td>
                  {u.id !== me.id && (
                    <button
                      className="danger"
                      onClick={async () => {
                        if (!confirm(`${u.username} löschen?`)) return;
                        await api("DELETE", `/users/${u.id}`).catch((e) => setError(e.message));
                        load();
                      }}
                    >
                      Löschen
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form
        className="card"
        style={{ marginTop: 16, maxWidth: 560 }}
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          try {
            await api("POST", "/users", form);
            setForm({ username: "", displayName: "", password: "" });
            load();
          } catch (x: any) {
            setError(x.message);
          }
        }}
      >
        <h3 style={{ marginTop: 0 }}>Benutzer anlegen</h3>
        <div className="grid2">
          <label className="f">
            <span>Benutzername</span>
            <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required />
          </label>
          <label className="f">
            <span>Name</span>
            <input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          </label>
        </div>
        <label className="f">
          <span>Passwort (mindestens 12 Zeichen)</span>
          <input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
        </label>
        <div className="row end" style={{ marginTop: 12 }}>
          <button className="primary">Anlegen</button>
        </div>
      </form>
    </>
  );
}

export function SettingsPage() {
  const [ov, setOv] = useState<Overview>();
  const [pw, setPw] = useState({ current: "", password: "", repeat: "" });
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    api<Overview>("GET", "/overview").then(setOv);
  }, []);
  if (!ov) return null;
  return (
    <>
      <h1>Einstellungen</h1>
      <p className="sub">Server {ov.publicUrl}</p>
      {error && <div className="msg err">{error}</div>}
      {msg && <div className="msg ok">{msg}</div>}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Client-Paket und Updates</h3>
        <p>
          Version auf diesem Server: <b>{ov.package?.version ?? "kein Paket"}</b>
          {ov.package && <span className="hint"> · gebaut {fmtDate(ov.package.builtAt)} · SHA-256 {ov.package.sha256.slice(0, 16)}…</span>}
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={ov.autoUpdate}
            onChange={async (e) => {
              await api("PUT", "/settings", { autoUpdate: e.target.checked });
              setOv({ ...ov, autoUpdate: e.target.checked });
            }}
          />
          Neue Versionen automatisch an alle freigegebenen Proxys verteilen
        </label>
        <p className="hint">Aus: Updates werden je Proxy oder für alle gezielt unter „Proxys“ ausgerollt. Jeder Proxy kann Updates zusätzlich lokal ablehnen.</p>
        <h3>Installation</h3>
        <p className="hint" style={{ marginBottom: 8 }}>Mit Anmeldung bei diesem Server (PowerShell als Administrator):</p>
        <CopyLine text={ov.installCommand} />
        <p className="hint" style={{ margin: "12px 0 8px" }}>Mit anderem SMTP-Port:</p>
        <CopyLine text={`& ([scriptblock]::Create((irm ${ov.publicUrl}/install.ps1))) -Port 2525`} />
        <p className="hint" style={{ margin: "12px 0 8px" }}>Eigenständig ohne Verwaltungsserver (neuestes GitHub-Release):</p>
        <CopyLine text="irm https://github.com/dominguez-posh/m365-SMTPProxy/releases/latest/download/install.ps1 | iex" />
      </div>

      <form
        className="card"
        style={{ marginTop: 16, maxWidth: 560 }}
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          setMsg("");
          if (pw.password !== pw.repeat) return setError("Die neuen Passwörter stimmen nicht überein.");
          try {
            await api("POST", "/auth/password", { current: pw.current, password: pw.password });
            setPw({ current: "", password: "", repeat: "" });
            setMsg("Passwort geändert.");
          } catch (x: any) {
            setError(x.message);
          }
        }}
      >
        <h3 style={{ marginTop: 0 }}>Eigenes Passwort ändern</h3>
        <label className="f">
          <span>Aktuelles Passwort</span>
          <input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required />
        </label>
        <div className="grid2">
          <label className="f">
            <span>Neues Passwort</span>
            <input type="password" autoComplete="new-password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} required />
          </label>
          <label className="f">
            <span>Wiederholen</span>
            <input type="password" autoComplete="new-password" value={pw.repeat} onChange={(e) => setPw({ ...pw, repeat: e.target.value })} required />
          </label>
        </div>
        <div className="row end" style={{ marginTop: 12 }}>
          <button className="primary">Ändern</button>
        </div>
      </form>
    </>
  );
}
