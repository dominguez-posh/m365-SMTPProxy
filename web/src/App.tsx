import { useEffect, useState, type FormEvent } from "react";
import { LuHistory, LuKeyRound, LuLock, LuLogOut, LuMenu, LuServer, LuSettings, LuShieldCheck, LuTriangleAlert, LuUsers } from "react-icons/lu";
import { api } from "./api";
import { LoginBrand, MfaDialog, MfaForcedSetup, MfaVerify } from "./Mfa";
import { ProxyDetail } from "./ProxyDetail";
import { ProxyList, type ProxySummary } from "./ProxyList";
import { EventsPage, SettingsPage, UsersPage } from "./Pages";
import { AppProvider, useApp } from "./state";
import { BrandMark, BrandText, Loading, Note, Toasts } from "./ui";
import { passkeySupported } from "./webauthn";

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
  return (
    <AppProvider>
      <Gate />
      <Toasts />
    </AppProvider>
  );
}

function Gate() {
  const { user } = useApp();
  if (user === undefined) return <Loading />;
  if (!user) return <Login />;
  if (user.mfaRequired === "setup") return <MfaForcedSetup />;
  if (user.mfaRequired === "verify") return <MfaVerify />;
  return <Shell />;
}

function Shell() {
  const { user, logout } = useApp();
  const [page, id] = useRoute();
  const [menu, setMenu] = useState(false);
  const [account, setAccount] = useState(false);
  const [pending, setPending] = useState(0);
  const [version, setVersion] = useState<string>();

  useEffect(() => {
    const load = () =>
      api<ProxySummary[]>("GET", "/proxies")
        .then((l) => setPending(l.filter((p) => p.state === "pending").length))
        .catch(() => undefined);
    load();
    api<{ package?: { version: string } }>("GET", "/overview").then((o) => setVersion(o.package?.version), () => undefined);
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => setMenu(false), [page, id]);

  const nav = (href: string, label: string, Icon: typeof LuServer, active: boolean, count?: number) => (
    <a href={href} aria-current={active ? "page" : undefined}>
      <Icon aria-hidden /> {label}
      {!!count && <span className="count">{count}</span>}
    </a>
  );
  const initials = (user!.displayName || user!.username).split(/[\s.@_-]+/).filter(Boolean).slice(0, 2).map((x) => x[0]!.toUpperCase()).join("");

  return (
    <div className="shell" data-menu={menu ? "open" : "closed"}>
      <header className="topbar">
        <button onClick={() => setMenu(!menu)} aria-label="Menü">
          <LuMenu />
        </button>
        <BrandText />
      </header>
      <aside className="side">
        <a className="brand" href="#/">
          <BrandMark />
          <BrandText />
        </a>
        <nav className="nav" aria-label="Navigation">
          {nav("#/", "Proxys", LuServer, page === "" || page === "proxy", pending)}
          {nav("#/events", "Ereignisse", LuHistory, page === "events")}
          {nav("#/users", "Benutzer", LuUsers, page === "users")}
          {nav("#/settings", "Einstellungen", LuSettings, page === "settings")}
        </nav>
        <div className="side-foot">
          <button className="side-user" onClick={() => setAccount(true)} title="Anmeldung und zweiter Faktor">
            <span className="avatar">{initials}</span>
            <span className="u">
              <b>{user!.displayName}</b>
              <span>{user!.mfaEnabled ? "Zweiter Faktor aktiv" : "Ohne zweiten Faktor"}</span>
            </span>
          </button>
          <button className="side-link" onClick={() => setAccount(true)}>
            <LuShieldCheck aria-hidden /> Passkeys und MFA
          </button>
          <button className="side-link" onClick={() => logout()}>
            <LuLogOut aria-hidden /> Abmelden
          </button>
          {version && <span className="version">Client-Version {version}</span>}
        </div>
      </aside>
      <main className="main">
        {page === "proxy" && id ? <ProxyDetail id={id} /> : page === "events" ? <EventsPage /> : page === "users" ? <UsersPage /> : page === "settings" ? <SettingsPage /> : <ProxyList />}
      </main>
      {account && <MfaDialog onClose={() => setAccount(false)} />}
    </div>
  );
}

function Login() {
  const { setupRequired, setUser, login, loginPasskey } = useApp();
  const [username, setUsername] = useState(setupRequired ? "admin" : "");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const insecure = location.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(location.hostname);

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (err) {
      setError((err as Error).message);
      setPassword("");
      setRepeat("");
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (setupRequired && password !== repeat) return setError("Die Passwörter stimmen nicht überein.");
    run(async () => (setupRequired ? setUser(await api("POST", "/setup/admin", { username, password })) : login(username.trim(), password)));
  };

  return (
    <div className="login-shell">
      <div className="login-card">
        <LoginBrand />
        <h1>{setupRequired ? "Ersteinrichtung" : "Anmelden"}</h1>
        <p className="muted">
          {setupRequired
            ? "Der Verwaltungsserver ist neu. Legen Sie den ersten Administrator mit eigenem Passwort an (mindestens 12 Zeichen); danach richten Sie einen zweiten Faktor ein."
            : "Melden Sie sich am Verwaltungsserver Ihrer SMTP-Proxys an."}
        </p>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="username">Benutzername</label>
            <input id="username" className="input" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} autoFocus={!setupRequired} required />
          </div>
          <div className="field">
            <label htmlFor="password">Passwort</label>
            <input id="password" className="input" type="password" autoComplete={setupRequired ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!error} autoFocus={setupRequired} required />
            {!setupRequired && error && (
              <span className="err" role="alert">
                {error}
              </span>
            )}
          </div>
          {setupRequired && (
            <div className="field">
              <label htmlFor="repeat">Passwort wiederholen</label>
              <input id="repeat" className="input" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
              {error && (
                <span className="err" role="alert">
                  {error}
                </span>
              )}
            </div>
          )}
          <button className="btn primary big full" type="submit" disabled={!username.trim() || !password || busy}>
            {busy ? <span className="spinner" /> : <LuLock aria-hidden />} {setupRequired ? "Administrator anlegen" : busy ? "Wird geprüft …" : "Anmelden"}
          </button>
        </form>
        {!setupRequired && passkeySupported() && (
          <>
            <div className="login-or">
              <span>oder</span>
            </div>
            <button type="button" className="btn big full" disabled={busy} onClick={() => run(loginPasskey)}>
              <LuKeyRound aria-hidden /> Mit Passkey anmelden
            </button>
          </>
        )}
        <div style={{ marginTop: 18 }}>
          {insecure ? (
            <Note kind="danger">
              <span className="row" style={{ gap: 6 }}>
                <LuTriangleAlert aria-hidden style={{ width: 15, height: 15 }} /> Diese Seite ist nicht per HTTPS geöffnet. Das Passwort würde unverschlüsselt übertragen.
              </span>
            </Note>
          ) : (
            <p className="faint small" style={{ margin: 0 }}>
              Die Verbindung ist per HTTPS verschlüsselt. Passwort vergessen? Ein anderer Administrator kann ein neues setzen; auf dem Server: <code>npm run reset-password</code>.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
