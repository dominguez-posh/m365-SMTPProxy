import { useEffect, useState } from "react";
import type { User } from "../../shared/types";
import { api, ApiError } from "./api";
import { ProxyList } from "./ProxyList";
import { ProxyDetail } from "./ProxyDetail";
import { EventsPage, SettingsPage, UsersPage } from "./Pages";

/** hash routing: #/ , #/proxy/<id>, #/events, #/users, #/settings */
function useRoute() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash.replace(/^#\/?/, "").split("/");
}

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [setup, setSetup] = useState(false);

  useEffect(() => {
    api<{ required: boolean }>("GET", "/setup")
      .then((s) => {
        setSetup(s.required);
        if (!s.required) return api<User>("GET", "/auth/session").then(setUser, () => setUser(null));
        setUser(null);
      })
      .catch(() => setUser(null));
    const out = () => setUser(null);
    addEventListener("smtpproxy:logout", out);
    return () => removeEventListener("smtpproxy:logout", out);
  }, []);

  if (user === undefined) return null;
  if (!user) return <Login setup={setup} onDone={(u) => (setSetup(false), setUser(u))} />;
  return <Shell user={user} onLogout={() => setUser(null)} />;
}

function Shell({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [page, id] = useRoute();
  const nav = (href: string, label: string, active: boolean) => (
    <a className={"nav" + (active ? " active" : "")} href={href}>
      {label}
    </a>
  );
  return (
    <div className="layout">
      <aside className="side">
        <div className="brand">
          <img src="/favicon.svg" alt="" /> M365 SMTP Proxy
        </div>
        {nav("#/", "Proxys", page === "" || page === "proxy")}
        {nav("#/events", "Ereignisse", page === "events")}
        {nav("#/users", "Benutzer", page === "users")}
        {nav("#/settings", "Einstellungen", page === "settings")}
        <div className="spacer" />
        <div className="who">{user.displayName}</div>
        <a
          className="nav"
          href="#/"
          onClick={async (e) => {
            e.preventDefault();
            await api("POST", "/auth/logout").catch(() => {});
            onLogout();
          }}
        >
          Abmelden
        </a>
      </aside>
      <main>
        {page === "proxy" && id ? <ProxyDetail id={id} /> : page === "events" ? <EventsPage /> : page === "users" ? <UsersPage me={user} /> : page === "settings" ? <SettingsPage /> : <ProxyList />}
      </main>
    </div>
  );
}

function Login({ setup, onDone }: { setup: boolean; onDone: (u: User) => void }) {
  const [username, setUsername] = useState(setup ? "admin" : "");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (setup && password !== repeat) return setError("Die Passwörter stimmen nicht überein.");
    setBusy(true);
    try {
      onDone(await api<User>("POST", setup ? "/setup/admin" : "/auth/login", { username, password }));
    } catch (x) {
      setError(x instanceof ApiError ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center">
      <form className="card login" onSubmit={submit}>
        <div className="brand" style={{ padding: "0 0 8px" }}>
          <img src="/favicon.svg" alt="" /> M365 SMTP Proxy
        </div>
        <h1>{setup ? "Ersteinrichtung" : "Anmelden"}</h1>
        {setup && <p className="hint">Der Server ist neu. Lege den ersten Administrator mit eigenem Passwort an (mindestens 12 Zeichen).</p>}
        {error && <div className="msg err">{error}</div>}
        <label className="f">
          <span>Benutzername</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus={!setup} required />
        </label>
        <label className="f">
          <span>Passwort</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={setup ? "new-password" : "current-password"} autoFocus={setup} required />
        </label>
        {setup && (
          <label className="f">
            <span>Passwort wiederholen</span>
            <input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" required />
          </label>
        )}
        <div className="row end" style={{ marginTop: 16 }}>
          <button className="primary" disabled={busy}>
            {setup ? "Administrator anlegen" : "Anmelden"}
          </button>
        </div>
      </form>
    </div>
  );
}
