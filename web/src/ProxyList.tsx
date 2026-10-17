import { useEffect, useState } from "react";
import type { Overview, Proxy } from "../../shared/types";
import { ago, api } from "./api";

export type ProxySummary = Omit<Proxy, "config" | "queue" | "failed" | "desired"> & { hasDesired: boolean; tenant: string; port?: number };

export const online = (p: { lastSeen?: string }) => !!p.lastSeen && Date.now() - Date.parse(p.lastSeen) < 3 * 60 * 1000;

/** overall state of a proxy as one badge */
export function Health({ p }: { p: ProxySummary | Proxy }) {
  if (p.state === "pending") return <span className="badge b-info">Wartet auf Freigabe</span>;
  if (p.state === "rejected") return <span className="badge b-muted">Abgelehnt</span>;
  if (!online(p)) return <span className="badge b-bad">Offline</span>;
  const s = p.status;
  if (!s) return <span className="badge b-muted">Keine Daten</span>;
  if (s.smtpError || !s.listeningOn) return <span className="badge b-bad">SMTP-Fehler</span>;
  if (!s.m365Connected) return <span className="badge b-warn">Nicht mit M365 verbunden</span>;
  if (s.m365Error) return <span className="badge b-warn">M365-Fehler</span>;
  if (s.failedCount > 0) return <span className="badge b-warn">{s.failedCount} fehlgeschlagen</span>;
  return <span className="badge b-ok">In Ordnung</span>;
}

export function CopyLine({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="copy">
      <code>{text}</code>
      <button
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }}
      >
        {done ? "Kopiert" : "Kopieren"}
      </button>
    </div>
  );
}

export function ProxyList() {
  const [list, setList] = useState<ProxySummary[]>([]);
  const [ov, setOv] = useState<Overview>();
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");

  const load = () =>
    Promise.all([api<ProxySummary[]>("GET", "/proxies"), api<Overview>("GET", "/overview")])
      .then(([l, o]) => (setList(l), setOv(o), setError("")))
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) setMsg(ok);
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const pending = list.filter((p) => p.state === "pending");
  const pkg = ov?.package;
  const outdated = list.filter((p) => p.state === "approved" && pkg && p.version !== pkg.version);

  return (
    <>
      <div className="between">
        <div>
          <h1>Proxys</h1>
          <p className="sub">SMTP-Proxys, die sich bei diesem Server angemeldet haben. Jeder Proxy läuft auch ohne Server eigenständig weiter.</p>
        </div>
        {outdated.length > 0 && (
          <button onClick={() => act(() => api("POST", "/proxies-update"), `Update auf ${pkg!.version} an ${outdated.length} Proxys ausgerollt.`)}>
            Alle auf {pkg!.version} aktualisieren ({outdated.length})
          </button>
        )}
      </div>
      {error && <div className="msg err">{error}</div>}
      {msg && <div className="msg ok">{msg}</div>}

      {pending.length > 0 && (
        <>
          <h2>Warten auf Freigabe</h2>
          <p className="hint" style={{ marginBottom: 8 }}>
            Nur freigeben, wenn Computername und Fingerabdruck zum Proxy passen (Fingerabdruck in der Proxy-Oberfläche unter „Verwaltung“).
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Computer</th>
                  <th>Fingerabdruck</th>
                  <th>Schlüssel</th>
                  <th>Adresse</th>
                  <th>Gemeldet</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pending.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <b>{p.host}</b>
                      <div className="hint">{p.domain}</div>
                    </td>
                    <td className="mono">{p.fingerprint}</td>
                    <td>{p.keyStorage === "tpm" ? "TPM" : "Software"}</td>
                    <td>{p.lastIp}</td>
                    <td>{ago(p.registeredAt)}</td>
                    <td>
                      <div className="row end">
                        <button className="primary" onClick={() => act(() => api("POST", `/proxies/${p.id}/approve`), `${p.host} freigegeben.`)}>
                          Freigeben
                        </button>
                        <button className="danger" onClick={() => act(() => api("POST", `/proxies/${p.id}/reject`))}>
                          Ablehnen
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2>Alle Proxys</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Zustand</th>
              <th>Tenant</th>
              <th>SMTP</th>
              <th>Warteschlange</th>
              <th>Version</th>
              <th>Letzter Kontakt</th>
            </tr>
          </thead>
          <tbody>
            {list.filter((p) => p.state !== "pending").map((p) => (
              <tr key={p.id} className="click" onClick={() => (location.hash = `#/proxy/${p.id}`)}>
                <td>
                  <b>{p.name}</b>
                  {p.name !== p.host && <div className="hint">{p.host}</div>}
                </td>
                <td>
                  <Health p={p} /> {p.hasDesired && <span className="badge b-info">Änderung ausstehend</span>}
                </td>
                <td>{p.tenant || "–"}</td>
                <td>{p.status?.listeningOn ?? "–"}</td>
                <td>{p.status ? `${p.status.queueLength} / ${p.status.failedCount}` : "–"}</td>
                <td>
                  {p.version}{" "}
                  {p.updateTarget ? <span className="badge b-info">→ {p.updateTarget}</span> : pkg && p.state === "approved" && p.version !== pkg.version ? <span className="badge b-muted">{pkg.version} verfügbar</span> : null}
                </td>
                <td>{ago(p.lastSeen)}</td>
              </tr>
            ))}
            {list.filter((p) => p.state !== "pending").length === 0 && (
              <tr>
                <td colSpan={7} className="empty">
                  Noch kein Proxy verbunden.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {ov && (
        <>
          <h2>Neuen Proxy installieren</h2>
          <p className="hint" style={{ marginBottom: 8 }}>
            In einer PowerShell als Administrator auf dem Zielrechner ausführen. Der Proxy wird installiert, meldet sich hier an und erscheint oben unter „Warten auf Freigabe“.
            Client-Version {pkg?.version ?? "– (kein Paket auf dem Server)"}.
          </p>
          <CopyLine text={ov.installCommand} />
        </>
      )}
    </>
  );
}
