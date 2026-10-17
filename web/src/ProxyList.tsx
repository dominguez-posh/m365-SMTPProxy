import { useEffect, useState } from "react";
import { LuCheck, LuDownload, LuInbox, LuMailCheck, LuRefreshCw, LuServer, LuShieldAlert, LuTriangleAlert, LuX } from "react-icons/lu";
import { isNewer, type Overview, type Proxy } from "../../shared/types";
import { ago, api } from "./api";
import { useApp } from "./state";
import { CopyLine, Empty, Loading, Note, useConfirm } from "./ui";

export type ProxySummary = Omit<Proxy, "config" | "queue" | "failed" | "desired"> & { hasDesired: boolean; tenant: string; port?: number };

export const online = (p: { lastSeen?: string }) => !!p.lastSeen && Date.now() - Date.parse(p.lastSeen) < 3 * 60 * 1000;

/** overall state of a proxy: badge class and text */
export function healthOf(p: ProxySummary | Proxy): [string, string] {
  if (p.state === "pending") return ["info", "Wartet auf Freigabe"];
  if (p.state === "rejected") return ["na", "Abgelehnt"];
  if (!online(p)) return ["bad", "Offline"];
  const s = p.status;
  if (!s) return ["na", "Keine Daten"];
  if (s.smtpError || !s.listeningOn) return ["bad", "SMTP-Fehler"];
  if (!s.m365Connected) return ["warn", "Nicht mit M365 verbunden"];
  if (s.m365Error) return ["warn", "M365-Fehler"];
  if (s.failedCount > 0) return ["warn", `${s.failedCount} fehlgeschlagen`];
  return ["ok", "In Ordnung"];
}
export function Health({ p }: { p: ProxySummary | Proxy }) {
  const [cls, text] = healthOf(p);
  return <span className={`badge ${cls}`}>{text}</span>;
}

export function ProxyList() {
  const { toast } = useApp();
  const { ask, node } = useConfirm();
  const [list, setList] = useState<ProxySummary[]>();
  const [ov, setOv] = useState<Overview>();
  const [error, setError] = useState("");

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
      if (ok) toast(ok);
      await load();
    } catch (e: any) {
      toast(e.message, "error");
    }
  };

  if (!list) return error ? <Note kind="danger">{error}</Note> : <Loading />;
  const pending = list.filter((p) => p.state === "pending");
  const active = list.filter((p) => p.state !== "pending");
  const pkg = ov?.package;
  const outdated = list.filter((p) => p.state === "approved" && pkg && isNewer(pkg.version, p.version));
  const healthy = active.filter((p) => healthOf(p)[0] === "ok").length;
  const problems = active.filter((p) => ["bad", "warn"].includes(healthOf(p)[0])).length;
  const queued = active.reduce((n, p) => n + (p.status?.queueLength ?? 0), 0);
  const failed = active.reduce((n, p) => n + (p.status?.failedCount ?? 0), 0);

  return (
    <>
      {node}
      <div className="page-head">
        <div>
          <h1>Proxys</h1>
          <p className="sub">SMTP-Proxys, die sich bei diesem Server angemeldet haben. Jeder Proxy arbeitet auch ohne Server eigenständig weiter.</p>
        </div>
        <div className="page-actions">
          {outdated.length > 0 && (
            <button
              className="btn"
              onClick={async () =>
                (await ask(`Version ${pkg!.version} an ${outdated.length} Proxy(s) ausrollen? Jeder Proxy installiert sie beim nächsten Kontakt und startet seinen Dienst neu.`, { action: "Ausrollen" })) &&
                act(() => api("POST", "/proxies-update"), `Update auf ${pkg!.version} an ${outdated.length} Proxy(s) ausgerollt.`)
              }
            >
              <LuDownload aria-hidden /> Alle auf {pkg!.version} aktualisieren
            </button>
          )}
          <button className="btn ghost" onClick={() => load()} title="Aktualisieren">
            <LuRefreshCw aria-hidden />
          </button>
        </div>
      </div>
      {error && <Note kind="danger">{error}</Note>}

      <div className="kpi-row">
        <div className="kpi">
          <span className="k">
            <LuServer aria-hidden /> Proxys
          </span>
          <span className="v">{active.length}</span>
          <span className="d">{healthy} in Ordnung</span>
        </div>
        <div className={`kpi ${problems ? "warn" : ""}`}>
          <span className="k">
            <LuShieldAlert aria-hidden /> Mit Problemen
          </span>
          <span className="v">{problems}</span>
          <span className="d">offline, SMTP- oder M365-Fehler</span>
        </div>
        <div className="kpi">
          <span className="k">
            <LuInbox aria-hidden /> In Warteschlange
          </span>
          <span className="v">{queued}</span>
          <span className="d">über alle Proxys</span>
        </div>
        <div className={`kpi ${failed ? "bad" : ""}`}>
          <span className="k">
            <LuTriangleAlert aria-hidden /> Fehlgeschlagen
          </span>
          <span className="v">{failed}</span>
          <span className="d">endgültig nicht zugestellt</span>
        </div>
      </div>

      {pending.length > 0 && (
        <div className="panel" style={{ marginBottom: 18, borderColor: "color-mix(in srgb, var(--info) 40%, var(--line))" }}>
          <div className="panel-head">
            <h3>Neue Proxys warten auf Freigabe</h3>
            <span className="muted small">Nur freigeben, wenn Computername und Fingerabdruck stimmen (Proxy-Oberfläche → Verwaltung).</span>
          </div>
          <div className="table-wrap">
            <table className="tbl">
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
                      <div className="t">{p.host}</div>
                      <div className="s">{p.domain}</div>
                    </td>
                    <td className="mono">{p.fingerprint}</td>
                    <td>{p.keyStorage === "tpm" ? "TPM" : "Software"}</td>
                    <td>{p.lastIp}</td>
                    <td className="nowrap">{ago(p.registeredAt)}</td>
                    <td className="right">
                      <div className="row" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                        <button className="btn small primary" onClick={() => act(() => api("POST", `/proxies/${p.id}/approve`), `${p.host} freigegeben.`)}>
                          <LuCheck aria-hidden /> Freigeben
                        </button>
                        <button className="btn small danger" onClick={() => act(() => api("POST", `/proxies/${p.id}/reject`), `${p.host} abgelehnt.`)}>
                          <LuX aria-hidden /> Ablehnen
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Proxy</th>
                <th>Zustand</th>
                <th>Tenant</th>
                <th>SMTP</th>
                <th className="right">Wartend / Fehler</th>
                <th>Version</th>
                <th>Letzter Kontakt</th>
              </tr>
            </thead>
            <tbody>
              {active.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => (location.hash = `#/proxy/${p.id}`)}>
                  <td>
                    <div className="t">{p.name}</div>
                    <div className="s">{p.name !== p.host ? p.host : p.domain ?? ""}</div>
                  </td>
                  <td>
                    <div className="row" style={{ gap: 6 }}>
                      <Health p={p} />
                      {p.hasDesired && <span className="tag info">Änderung ausstehend</span>}
                    </div>
                  </td>
                  <td>{p.tenant || <span className="faint">–</span>}</td>
                  <td className="mono small">{p.status?.listeningOn ?? <span className="faint">–</span>}</td>
                  <td className="right num">{p.status ? `${p.status.queueLength} / ${p.status.failedCount}` : "–"}</td>
                  <td className="nowrap">
                    {p.version}{" "}
                    {p.updateTarget ? <span className="tag info">→ {p.updateTarget}</span> : pkg && p.state === "approved" && isNewer(pkg.version, p.version) ? <span className="tag">{pkg.version} verfügbar</span> : null}
                  </td>
                  <td className="nowrap">{ago(p.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {active.length === 0 && <Empty icon={<LuMailCheck aria-hidden />}>Noch kein Proxy verbunden. Mit dem Befehl unten installieren.</Empty>}
      </div>

      {ov && (
        <div className="panel panel-pad" style={{ marginTop: 18 }}>
          <h3 style={{ marginBottom: 6 }}>Neuen Proxy installieren</h3>
          <p className="muted small">
            In einer PowerShell als Administrator auf dem Zielrechner ausführen. Der Proxy wird installiert, meldet sich hier an und erscheint oben zur Freigabe. Client-Version {pkg?.version ?? "– (kein Paket auf dem Server)"}.
          </p>
          <CopyLine text={ov.installCommand} />
        </div>
      )}
    </>
  );
}
