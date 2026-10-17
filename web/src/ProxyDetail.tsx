import { useEffect, useState } from "react";
import {
  LuActivity, LuCheck, LuChevronRight, LuCloud, LuDownload, LuFileText, LuInbox, LuInfo, LuKeyRound, LuMail, LuPencil, LuPlus, LuRefreshCw, LuRotateCcw, LuSave, LuSearch, LuSettings, LuShieldCheck, LuTrash2, LuUsers,
} from "react-icons/lu";
import { isNewer } from "../../shared/types";
import type { MailLogEntry, Overview, Proxy, ProxyConfig, QueueItem, ServiceLogEntry, SmtpUser } from "../../shared/types";
import { ago, api, fmtDate, randomPassword } from "./api";
import { Health, online } from "./ProxyList";
import { useApp } from "./state";
import { Empty, Loading, Note, useConfirm, usePrompt } from "./ui";

type Tab = "status" | "config" | "queue" | "log" | "info";

export function ProxyDetail({ id }: { id: string }) {
  const { toast } = useApp();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [p, setP] = useState<Proxy>();
  const [ov, setOv] = useState<Overview>();
  const [tab, setTab] = useState<Tab>("status");
  const [error, setError] = useState("");

  const load = () =>
    Promise.all([api<Proxy>("GET", `/proxies/${id}`), api<Overview>("GET", "/overview")])
      .then(([x, o]) => (setP(x), setOv(o), setError("")))
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [id]);

  const act = async (fn: () => Promise<any>, ok?: string) => {
    try {
      const r = await fn();
      if (r && typeof r === "object" && "id" in r && "state" in r) setP(r);
      if (ok) toast(ok);
      return true;
    } catch (e: any) {
      toast(e.message, "error");
      return false;
    }
  };

  if (!p) return error ? <Note kind="danger">{error}</Note> : <Loading />;
  const s = p.status;
  const pkg = ov?.package;
  const tabs: [Tab, string, typeof LuActivity, number?][] = [
    ["status", "Status", LuActivity],
    ["config", "Einstellungen", LuSettings],
    ["queue", "Warteschlange", LuInbox, s ? s.queueLength + s.failedCount : undefined],
    ["log", "Protokoll", LuFileText],
    ["info", "Info", LuInfo],
  ];

  return (
    <>
      {confirm.node}
      {prompt.node}
      <div className="crumb">
        <a href="#/">Proxys</a> <LuChevronRight aria-hidden /> {p.name}
      </div>
      <div className="page-head">
        <div>
          <h1 className="row" style={{ gap: 12 }}>
            {p.name} <Health p={p} />
          </h1>
          <p className="sub">
            {p.host}
            {p.domain ? ` · ${p.domain}` : ""} · Version {p.version} · letzter Kontakt {ago(p.lastSeen)}
          </p>
        </div>
        <div className="page-actions">
          {p.state === "pending" && (
            <button className="btn primary" onClick={() => act(() => api("POST", `/proxies/${p.id}/approve`), "Freigegeben.")}>
              <LuCheck aria-hidden /> Freigeben
            </button>
          )}
          {p.state === "approved" && pkg && isNewer(pkg.version, p.version) && !p.updateTarget && (
            <button
              className="btn primary"
              onClick={async () =>
                (await confirm.ask(`Version ${pkg.version} auf ${p.name} installieren? Der Dienst startet dabei neu (wenige Sekunden ohne SMTP).`, { action: "Update ausrollen" })) &&
                act(() => api("POST", `/proxies/${p.id}/update`), `Update auf ${pkg.version} ausgerollt; der Proxy installiert es beim nächsten Kontakt.`)
              }
            >
              <LuDownload aria-hidden /> Update auf {pkg.version}
            </button>
          )}
          <button
            className="btn"
            onClick={async () => {
              const name = await prompt.ask("Proxy umbenennen", "Anzeigename", p.name);
              if (name) act(() => api("PATCH", `/proxies/${p.id}`, { name }), "Umbenannt.");
            }}
          >
            <LuPencil aria-hidden /> Umbenennen
          </button>
          <button
            className="btn danger"
            onClick={async () => {
              if (!(await confirm.ask(`${p.name} vom Server entfernen? Der Proxy läuft weiter und meldet sich neu an (erneute Freigabe nötig), solange die Serveradresse eingetragen ist.`, { danger: true, action: "Entfernen" }))) return;
              if (await act(() => api("DELETE", `/proxies/${p.id}`), `${p.name} entfernt.`)) location.hash = "#/";
            }}
          >
            <LuTrash2 aria-hidden /> Entfernen
          </button>
        </div>
      </div>
      {p.updateTarget && (
        <Note kind="info">
          Update auf {p.updateTarget} ist ausgerollt und wird beim nächsten Kontakt installiert{p.config?.management.acceptUpdates === false ? " – der Proxy nimmt aber keine Updates an (Einstellung am Proxy)" : ""}.
        </Note>
      )}
      {p.desired && (
        <Note kind="info">
          Geänderte Einstellungen von {p.desired.by} ({fmtDate(p.desired.at)}) warten auf Übernahme durch den Proxy.
        </Note>
      )}
      {p.desiredError && (
        <Note kind="warn">
          Einstellungen wurden nicht übernommen: {p.desiredError.message} ({fmtDate(p.desiredError.at)})
        </Note>
      )}

      {p.state !== "approved" ? (
        <Note kind="info">Status, Einstellungen und Protokolle sind sichtbar, sobald der Proxy freigegeben ist. Fingerabdruck: {p.fingerprint}</Note>
      ) : (
        <>
          <div className="tabs" role="tablist">
            {tabs.map(([k, l, Icon, n]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
                <Icon aria-hidden /> {l}
                {!!n && <span className={`count ${k === "queue" && s?.failedCount ? "warn" : ""}`}>{n}</span>}
              </button>
            ))}
          </div>
          {tab === "status" ? (
            <StatusTab p={p} />
          ) : tab === "config" ? (
            p.config ? <ConfigTab p={p} onSaved={setP} /> : <Empty>Noch keine Einstellungen gemeldet.</Empty>
          ) : tab === "queue" ? (
            <QueueTab p={p} act={act} ask={confirm.ask} />
          ) : tab === "log" ? (
            <LogTab id={p.id} />
          ) : (
            <InfoTab p={p} />
          )}
        </>
      )}
    </>
  );
}

function StatusTab({ p }: { p: Proxy }) {
  const s = p.status;
  if (!s) return <Empty>Noch kein Status gemeldet.</Empty>;
  const c = p.config;
  const up = online(p);
  return (
    <div className="stack">
      <div className="kpi-row" style={{ marginBottom: 0 }}>
        <div className={`kpi ${up ? "ok" : "bad"}`}>
          <span className="k">Dienst</span>
          <span className="v small-v">{up ? "Läuft" : "Offline"}</span>
          <span className="d">gestartet {fmtDate(s.startedAt)}</span>
        </div>
        <div className={`kpi ${s.listeningOn ? "" : "bad"}`}>
          <span className="k">SMTP</span>
          <span className="v small-v mono">{s.listeningOn ?? "lauscht nicht"}</span>
          <span className="d">{s.smtpError ?? `${s.activeSessions} aktive Verbindungen`}</span>
        </div>
        <div className={`kpi ${s.m365Connected && !s.m365Error ? "ok" : "warn"}`}>
          <span className="k">Microsoft 365</span>
          <span className="v small-v">{s.m365Connected ? "Verbunden" : "Nicht verbunden"}</span>
          <span className="d">{s.m365Error ?? c?.m365.tenantName ?? ""}</span>
        </div>
        <div className={`kpi ${s.failedCount ? "warn" : ""}`}>
          <span className="k">Warteschlange</span>
          <span className="v">{s.queueLength}</span>
          <span className="d">{s.failedCount} fehlgeschlagen</span>
        </div>
      </div>
      <div className="grid-2">
        <div className="panel">
          <div className="panel-head">
            <h3>
              <LuMail aria-hidden /> Zustellung seit Start
            </h3>
          </div>
          <dl className="dl panel-pad" style={{ margin: 0 }}>
            <dt>Zugestellt</dt>
            <dd className="num">{s.deliveredSinceStart}</dd>
            <dt>Fehlgeschlagen</dt>
            <dd className="num">{s.failedSinceStart}</dd>
            <dt>Letzte Zustellung</dt>
            <dd>{fmtDate(s.lastDelivery)}</dd>
            <dt>Letzter Fehler</dt>
            <dd>{s.lastDeliveryError ?? <span className="faint">–</span>}</dd>
          </dl>
        </div>
        {c && (
          <div className="panel">
            <div className="panel-head">
              <h3>
                <LuShieldCheck aria-hidden /> Microsoft 365 und Absender
              </h3>
            </div>
            <dl className="dl panel-pad" style={{ margin: 0 }}>
              <dt>Tenant</dt>
              <dd>{c.m365.tenantName || "–"}</dd>
              <dt>Zertifikat bis</dt>
              <dd>
                {fmtDate(c.m365.certificateExpires)}
                {(c.m365.permissionsVersion ?? 0) >= 2 && <div className="muted small">erneuert sich selbst 60 Tage vor Ablauf</div>}
              </dd>
              <dt>Absender</dt>
              <dd>
                {c.senders.exchangeScopeEnabled ? "in Exchange eingeschränkt" : "nur im Proxy geprüft"} · {c.senders.allowedAddresses.length} Adressen, {c.senders.allowedDomains.length} Domänen
              </dd>
              <dt>Freigegebenes Postfach</dt>
              <dd>
                {c.senders.sharedMailbox ? (
                  <>
                    {c.senders.sharedMailbox}
                    <div className="muted small">Aliasse: {c.senders.sharedMailboxAliases?.join(", ") || "keine"}</div>
                  </>
                ) : (
                  <span className="faint">nicht eingerichtet</span>
                )}
              </dd>
              <dt>Domänen</dt>
              <dd>{c.m365.domains.join(", ") || "–"}</dd>
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}

const lines = (l: string[]) => l.join("\n");
const fromLines = (s: string) => [...new Set(s.split(/[\r\n,;]+/).map((x) => x.trim()).filter(Boolean))];
/** local part (left of the @) as Exchange accepts it */
const localPartOk = (s: string) => /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(s) && s.length <= 64;
/** first own domain of the tenant, otherwise the onmicrosoft.com domain */
const preferredDomain = (domains: string[]) => domains.find((d) => !d.endsWith(".onmicrosoft.com")) ?? domains[0] ?? "";

/** Allowed addresses: list plus input of the local part with a dropdown of the tenant domains. */
function AddressEditor({ value, onChange, domains }: { value: string[]; onChange: (v: string[]) => void; domains: string[] }) {
  const [local, setLocal] = useState("");
  const [domain, setDomain] = useState(() => preferredDomain(domains));
  const [error, setError] = useState("");
  const add = () => {
    const l = local.trim().toLowerCase();
    if (l.includes("@")) return setError("Nur den Teil vor dem @ eintragen, die Domäne in der Liste wählen.");
    if (!localPartOk(l)) return setError(`„${l}“ ist kein gültiger Name für eine E-Mail-Adresse.`);
    if (!domain) return setError("Der Proxy hat noch keine Domänen gemeldet (nicht mit Microsoft 365 verbunden).");
    const a = `${l}@${domain}`;
    if (!value.includes(a)) onChange([...value, a]);
    setLocal("");
    setError("");
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      {value.length === 0 ? (
        <span className="muted small">Keine einzelnen Adressen eingetragen.</span>
      ) : (
        <div className="row" style={{ gap: 6 }}>
          {value.map((a) => (
            <span key={a} className="tag">
              {a}
              <button className="icon-btn" style={{ padding: 0 }} title="Entfernen" aria-label={`${a} entfernen`} onClick={() => onChange(value.filter((x) => x !== a))}>
                <LuTrash2 aria-hidden />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <input
          className="input"
          value={local}
          placeholder="scanner"
          aria-label="Teil vor dem @"
          onChange={(e) => setLocal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <span>@</span>
        <select className="select" value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="Domäne">
          {domains.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <button className="btn small" onClick={add}>
          <LuPlus aria-hidden /> Hinzufügen
        </button>
      </div>
      {error && <span className="help" style={{ color: "var(--bad)" }}>{error}</span>}
    </div>
  );
}

function ConfigTab({ p, onSaved }: { p: Proxy; onSaved: (p: Proxy) => void }) {
  const { toast } = useApp();
  const prompt = usePrompt();
  const base = p.desired?.config ?? p.config!;
  const [c, setC] = useState<ProxyConfig>(() => structuredClone(base));
  const [text, setText] = useState(() => ({
    anon: lines(base.smtp.anonymousNetworks),
    allowed: lines(base.smtp.allowedNetworks),
    domains: lines(base.senders.allowedDomains),
  }));
  const [addresses, setAddresses] = useState<string[]>(() => [...base.senders.allowedAddresses]);
  const [users, setUsers] = useState<(SmtpUser & { senders: string })[]>(() => base.users.map((u) => ({ ...u, senders: u.allowedSenders.join(", ") })));
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<{ name: string; password: string }[]>([]);
  const smtp = <K extends keyof ProxyConfig["smtp"]>(k: K, v: ProxyConfig["smtp"][K]) => setC({ ...c, smtp: { ...c.smtp, [k]: v } });

  const save = async () => {
    setBusy(true);
    const next: ProxyConfig = {
      ...c,
      smtp: { ...c.smtp, port: Number(c.smtp.port), maxMessageSizeMb: Number(c.smtp.maxMessageSizeMb), maxRecipients: Number(c.smtp.maxRecipients), anonymousNetworks: fromLines(text.anon), allowedNetworks: fromLines(text.allowed) },
      senders: { ...c.senders, allowedAddresses: addresses, allowedDomains: fromLines(text.domains).map((x) => x.replace(/^@/, "").toLowerCase()) },
      users: users.map(({ senders, ...u }) => ({ ...u, allowedSenders: fromLines(senders).map((x) => x.toLowerCase()) })),
    };
    try {
      const x = await api<Proxy>("PUT", `/proxies/${p.id}/config`, { config: next });
      setShown(users.filter((u) => u.newPassword).map((u) => ({ name: u.name, password: u.newPassword! })));
      setUsers(users.map(({ newPassword, ...u }) => u));
      onSaved(x);
      const exo = c.senders.exchangeScopeEnabled && (c.m365.permissionsVersion ?? 0) < 2 && lines(next.senders.allowedAddresses) !== lines(base.senders.allowedAddresses);
      toast("Gespeichert. Der Proxy übernimmt die Einstellungen beim nächsten Kontakt (innerhalb von etwa 30 Sekunden).");
      if (exo) toast("Diese Verbindung ist älter: einmal am Proxy einrichten (Oberfläche → Microsoft 365 → In Exchange einrichten / abgleichen). Danach gleicht der Proxy Exchange selbst ab.", "info");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      {prompt.node}
      {shown.length > 0 && (
        <Note kind="warn">
          <b>Neue Passwörter (nur jetzt sichtbar):</b>
          {shown.map((x) => (
            <div key={x.name}>
              {x.name}: <code>{x.password}</code>
            </div>
          ))}
        </Note>
      )}
      <div className="panel">
        <div className="panel-head">
          <h3>
            <LuMail aria-hidden /> SMTP-Empfang
          </h3>
        </div>
        <div className="panel-pad">
          <label className="check">
            <input type="checkbox" checked={c.smtp.enabled} onChange={(e) => smtp("enabled", e.target.checked)} /> <span>SMTP-Empfang aktiv</span>
          </label>
          <div className="form-2">
            <div className="field">
              <label>IP-Adresse</label>
              <input className="input" value={c.smtp.listenAddress} onChange={(e) => smtp("listenAddress", e.target.value)} />
              <span className="help">0.0.0.0 = alle IPv4-Adressen, :: = alle Adressen</span>
            </div>
            <div className="field">
              <label>Port</label>
              <input className="input" type="number" value={c.smtp.port} onChange={(e) => smtp("port", Number(e.target.value))} />
            </div>
            <div className="field">
              <label>Maximale Nachrichtengröße (MB)</label>
              <input className="input" type="number" value={c.smtp.maxMessageSizeMb} onChange={(e) => smtp("maxMessageSizeMb", Number(e.target.value))} />
            </div>
            <div className="field">
              <label>Maximale Empfänger je Nachricht</label>
              <input className="input" type="number" value={c.smtp.maxRecipients} onChange={(e) => smtp("maxRecipients", Number(e.target.value))} />
            </div>
            <div className="field">
              <label>Netze ohne Anmeldung (anonym)</label>
              <textarea className="textarea" value={text.anon} onChange={(e) => setText({ ...text, anon: e.target.value })} />
              <span className="help">Eine Adresse oder ein Netz je Zeile, z. B. 192.168.10.0/24 für Drucker.</span>
            </div>
            <div className="field">
              <label>Zugelassene Netze</label>
              <textarea className="textarea" value={text.allowed} onChange={(e) => setText({ ...text, allowed: e.target.value })} />
              <span className="help">Leer = jede Adresse darf sich verbinden (senden nur mit Anmeldung oder aus anonymen Netzen).</span>
            </div>
          </div>
          <label className="check">
            <input type="checkbox" checked={c.smtp.allowAuthWithoutTls} onChange={(e) => smtp("allowAuthWithoutTls", e.target.checked)} />
            <span>
              Anmeldung (AUTH) ohne TLS erlauben
              <span className="help">Benutzername und Passwort gehen lesbar über das Netz. TLS folgt in einer späteren Version.</span>
            </span>
          </label>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>
            <LuShieldCheck aria-hidden /> Erlaubte Absender
          </h3>
          <span className="muted small">Domänen des Tenants: {p.config!.m365.domains.join(", ") || "–"}</span>
        </div>
        <div className="panel-pad">
          <div className="form-2">
            <div className="field">
              <label>Adressen</label>
              <AddressEditor value={addresses} onChange={setAddresses} domains={p.config!.m365.domains} />
              <span className="help">
                Hat eine Adresse kein eigenes Postfach, legt der Proxy sie als Alias des freigegebenen Postfachs an
                {base.senders.sharedMailbox ? ` (${base.senders.sharedMailbox})` : " (vorher am Proxy unter Microsoft 365 einrichten)"}.
              </span>
            </div>
            <div className="field">
              <label>Domänen</label>
              <textarea className="textarea" value={text.domains} onChange={(e) => setText({ ...text, domains: e.target.value })} />
              <span className="help">Sind beide Listen leer, ist jede Adresse der Tenant-Domänen erlaubt.</span>
            </div>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={c.senders.autoCreateAliases ?? true}
              disabled={!base.senders.sharedMailbox}
              onChange={(e) => setC({ ...c, senders: { ...c.senders, autoCreateAliases: e.target.checked } })}
            />
            <span>
              Fehlende Absenderadressen automatisch als Alias anlegen
              <span className="help">
                {base.senders.sharedMailbox
                  ? `Adressen ohne eigenes Postfach werden Aliasse von ${base.senders.sharedMailbox}; gesendet wird aus diesem Postfach mit der Adresse als Absender.`
                  : "Erst am Proxy einrichten: Oberfläche → Microsoft 365 → In Exchange einrichten / abgleichen."}
              </span>
            </span>
          </label>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>
            <LuUsers aria-hidden /> SMTP-Benutzer
          </h3>
          <button
            className="btn small"
            onClick={async () => {
              const name = await prompt.ask("SMTP-Benutzer hinzufügen", "Benutzername");
              if (name) setUsers([...users, { name, enabled: true, description: "", allowedSenders: [], senders: "", newPassword: randomPassword() }]);
            }}
          >
            <LuPlus aria-hidden /> Benutzer hinzufügen
          </button>
        </div>
        {users.length === 0 ? (
          <Empty icon={<LuKeyRound aria-hidden />}>Keine SMTP-Benutzer. Geräte außerhalb der anonymen Netze brauchen einen Benutzer.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Benutzer</th>
                  <th>Aktiv</th>
                  <th>Beschreibung</th>
                  <th>Erlaubte Absender</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((u, i) => {
                  const set = (x: Partial<typeof u>) => setUsers(users.map((y, j) => (j === i ? { ...y, ...x } : y)));
                  return (
                    <tr key={i}>
                      <td>
                        <div className="t">{u.name}</div>
                        {u.newPassword && <div className="s">neues Passwort beim Speichern</div>}
                      </td>
                      <td>
                        <input type="checkbox" checked={u.enabled} onChange={(e) => set({ enabled: e.target.checked })} aria-label="Aktiv" />
                      </td>
                      <td>
                        <input className="input" value={u.description} onChange={(e) => set({ description: e.target.value })} />
                      </td>
                      <td>
                        <input className="input" value={u.senders} onChange={(e) => set({ senders: e.target.value })} placeholder="alle erlaubten" />
                      </td>
                      <td className="right">
                        <div className="row" style={{ flexWrap: "nowrap", justifyContent: "flex-end" }}>
                          <button className="btn small" onClick={() => set({ newPassword: randomPassword() })}>
                            <LuRotateCcw aria-hidden /> Passwort
                          </button>
                          <button className="icon-btn" title="Löschen" aria-label="Löschen" onClick={() => setUsers(users.filter((_, j) => j !== i))}>
                            <LuTrash2 aria-hidden />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>
            <LuCloud aria-hidden /> Zustellung und Verwaltung
          </h3>
        </div>
        <div className="panel-pad">
          <div className="form-2">
            <div className="field">
              <label>Wiederholen bis (Stunden)</label>
              <input className="input" type="number" value={c.delivery.retryHours} onChange={(e) => setC({ ...c, delivery: { ...c.delivery, retryHours: Number(e.target.value) } })} />
            </div>
            <div className="field">
              <label>Protokolle aufbewahren (Tage)</label>
              <input className="input" type="number" value={c.delivery.logRetentionDays} onChange={(e) => setC({ ...c, delivery: { ...c.delivery, logRetentionDays: Number(e.target.value) } })} />
            </div>
          </div>
          <label className="check">
            <input type="checkbox" checked={c.delivery.logSubjects} onChange={(e) => setC({ ...c, delivery: { ...c.delivery, logSubjects: e.target.checked } })} />
            <span>Betreffzeilen protokollieren (personenbezogene Daten)</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={c.management.acceptUpdates} onChange={(e) => setC({ ...c, management: { ...c.management, acceptUpdates: e.target.checked } })} />
            <span>Updates vom Server installieren</span>
          </label>
          <p className="faint small" style={{ margin: 0 }}>
            Microsoft-365-Verbindung, Exchange-Einschränkung und Serveradresse lassen sich nur am Proxy selbst ändern.
          </p>
        </div>
        <div className="panel-foot">
          {p.desired && (
            <button className="btn ghost" onClick={async () => onSaved(await api("DELETE", `/proxies/${p.id}/config`))}>
              Ausstehende Änderung verwerfen
            </button>
          )}
          <button className="btn primary" disabled={busy} onClick={save}>
            {busy ? <span className="spinner" /> : <LuSave aria-hidden />} Speichern
          </button>
        </div>
      </div>
    </div>
  );
}

function QueueTab({ p, act, ask }: { p: Proxy; act: (fn: () => Promise<any>, ok?: string) => Promise<boolean>; ask: (text: string, opts?: { danger?: boolean; action?: string }) => Promise<boolean> }) {
  const cmd = (type: string, arg?: string) => act(() => api("POST", `/proxies/${p.id}/commands`, { type, arg }), "Befehl gesendet; der Proxy führt ihn beim nächsten Kontakt aus.");
  const table = (items: QueueItem[] | undefined, failed: boolean) =>
    !items?.length ? (
      <Empty icon={<LuInbox aria-hidden />}>Keine Nachrichten.</Empty>
    ) : (
      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Empfangen</th>
              <th>Absender</th>
              <th>Empfänger</th>
              <th className="right">Versuche</th>
              <th>{failed ? "Fehler" : "Nächster Versuch / Fehler"}</th>
              {failed && <th />}
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <td className="nowrap">{fmtDate(i.receivedAt)}</td>
                <td>{i.from}</td>
                <td>{i.recipients.join(", ")}</td>
                <td className="right num">{i.attempts}</td>
                <td>
                  {!failed && <div>{fmtDate(i.nextAttemptAt)}</div>}
                  <div className="s">{i.lastError}</div>
                </td>
                {failed && (
                  <td className="right">
                    <div className="row" style={{ flexWrap: "nowrap", justifyContent: "flex-end" }}>
                      <button className="btn small" onClick={() => cmd("retryFailed", i.id)}>
                        <LuRotateCcw aria-hidden /> Erneut senden
                      </button>
                      <button className="icon-btn" title="Löschen" aria-label="Löschen" onClick={async () => (await ask("Nachricht endgültig löschen?", { danger: true })) && cmd("deleteFailed", i.id)}>
                        <LuTrash2 aria-hidden />
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  return (
    <div className="stack">
      {p.pendingCommands.length > 0 && <Note kind="info">{p.pendingCommands.length} Befehl(e) warten auf Ausführung durch den Proxy.</Note>}
      <div className="panel">
        <div className="panel-head">
          <h3>Warteschlange</h3>
          <button className="btn small" onClick={() => cmd("retryQueue")}>
            <LuRefreshCw aria-hidden /> Alle sofort versuchen
          </button>
        </div>
        {table(p.queue, false)}
      </div>
      <div className="panel">
        <div className="panel-head">
          <h3>Fehlgeschlagen</h3>
          {!!p.failed?.length && (
            <button className="btn small" onClick={() => cmd("retryFailed")}>
              <LuRotateCcw aria-hidden /> Alle erneut senden
            </button>
          )}
        </div>
        {table(p.failed, true)}
      </div>
    </div>
  );
}

const EVENT: Record<string, [string, string]> = {
  received: ["Angenommen", "info"],
  delivered: ["Zugestellt", "ok"],
  deferred: ["Verzögert", "warn"],
  failed: ["Fehlgeschlagen", "bad"],
  refused: ["Abgewiesen", "bad"],
};

function LogTab({ id }: { id: string }) {
  const [kind, setKind] = useState<"mail" | "service">("mail");
  const [event, setEvent] = useState("");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<(MailLogEntry | ServiceLogEntry)[]>();
  const [error, setError] = useState("");
  useEffect(() => {
    const t = setTimeout(
      () =>
        api<(MailLogEntry | ServiceLogEntry)[]>("GET", `/proxies/${id}/logs?kind=${kind}&event=${event}&q=${encodeURIComponent(q)}&limit=500`)
          .then((r) => (setRows(r), setError("")))
          .catch((e) => setError(e.message)),
      250,
    );
    return () => clearTimeout(t);
  }, [id, kind, event, q]);

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="row">
          <div className="seg" role="group" aria-label="Protokoll">
            <button aria-pressed={kind === "mail"} onClick={() => setKind("mail")}>
              Nachrichten
            </button>
            <button aria-pressed={kind === "service"} onClick={() => setKind("service")}>
              Dienst
            </button>
          </div>
          {kind === "mail" && (
            <select className="select" value={event} onChange={(e) => setEvent(e.target.value)} style={{ width: 180 }}>
              <option value="">Alle Ereignisse</option>
              {Object.entries(EVENT).map(([k, [l]]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="search" style={{ width: 300, maxWidth: "100%" }}>
          <LuSearch aria-hidden />
          <input className="input" placeholder="Suchen (Adresse, IP, Text)" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {error && (
        <div className="panel-pad">
          <Note kind="danger">{error}</Note>
        </div>
      )}
      {!rows ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty icon={<LuFileText aria-hidden />}>Keine Einträge.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              {kind === "mail" ? (
                <tr>
                  <th>Zeit</th>
                  <th>Ereignis</th>
                  <th>Client</th>
                  <th>Absender</th>
                  <th>Empfänger</th>
                  <th>Details</th>
                </tr>
              ) : (
                <tr>
                  <th>Zeit</th>
                  <th>Stufe</th>
                  <th>Meldung</th>
                </tr>
              )}
            </thead>
            <tbody>
              {rows.map((r) =>
                "event" in r ? (
                  <tr key={r.seq}>
                    <td className="nowrap">{fmtDate(r.time)}</td>
                    <td>
                      <span className={`badge ${EVENT[r.event]?.[1] ?? "na"}`}>{EVENT[r.event]?.[0] ?? r.event}</span>
                    </td>
                    <td className="nowrap">
                      {r.clientIp}
                      {r.user && <div className="s">{r.user}</div>}
                    </td>
                    <td>{r.from}</td>
                    <td>{r.to.join(", ")}</td>
                    <td>
                      {[r.subject, r.size ? `${(r.size / 1024).toFixed(1)} KB` : null, r.attempt > 1 ? `Versuch ${r.attempt}` : null].filter(Boolean).join(" · ")}
                      {r.detail && <div className="s">{r.detail}</div>}
                    </td>
                  </tr>
                ) : (
                  <tr key={r.seq}>
                    <td className="nowrap">{fmtDate(r.time)}</td>
                    <td>
                      <span className={`badge ${r.level === "error" ? "bad" : r.level === "warn" ? "warn" : "na"}`}>{r.level === "error" ? "Fehler" : r.level === "warn" ? "Warnung" : "Info"}</span>
                    </td>
                    <td>{r.message}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function InfoTab({ p }: { p: Proxy }) {
  const c = p.config;
  return (
    <div className="panel panel-pad">
      <dl className="dl" style={{ margin: 0 }}>
        <dt>Kennung</dt>
        <dd className="mono">{p.id}</dd>
        <dt>Fingerabdruck</dt>
        <dd className="mono">{p.fingerprint}</dd>
        <dt>Schlüssel</dt>
        <dd>{p.keyStorage === "tpm" ? "TPM" : "Software (nicht exportierbar)"}</dd>
        <dt>Betriebssystem</dt>
        <dd>{p.os ?? "–"}</dd>
        <dt>Registriert</dt>
        <dd>{fmtDate(p.registeredAt)}</dd>
        <dt>Freigegeben</dt>
        <dd>{p.approvedAt ? `${fmtDate(p.approvedAt)} durch ${p.approvedBy}` : "–"}</dd>
        <dt>Letzte Adresse</dt>
        <dd>{p.lastIp ?? "–"}</dd>
        <dt>Konfiguration</dt>
        <dd>{c ? `Revision ${c.revision}, geändert ${fmtDate(c.modifiedAt)} durch ${c.modifiedBy}` : "–"}</dd>
        {c && (
          <>
            <dt>Tenant</dt>
            <dd>
              {c.m365.tenantName} <span className="faint mono">{c.m365.tenantId}</span>
            </dd>
            <dt>App-ID</dt>
            <dd className="mono">{c.m365.clientId || "–"}</dd>
            <dt>Zertifikat</dt>
            <dd>
              <span className="mono">{c.m365.certificateThumbprint || "–"}</span> · gültig bis {fmtDate(c.m365.certificateExpires)}
            </dd>
            <dt>Verbunden</dt>
            <dd>{c.m365.connectedAt ? `${fmtDate(c.m365.connectedAt)} durch ${c.m365.connectedBy}` : "–"}</dd>
            <dt>Exchange-Einschränkung</dt>
            <dd>{c.senders.exchangeScopeEnabled ? `Gruppe ${c.senders.exchangeScopeGroup}, abgeglichen ${fmtDate(c.senders.exchangeScopeSyncedAt)}` : "nein"}</dd>
            <dt>Einstellungen vom Server</dt>
            <dd>{c.management.acceptRemoteConfig ? "werden übernommen" : "werden nicht übernommen"}</dd>
          </>
        )}
        {p.notes && (
          <>
            <dt>Notiz</dt>
            <dd>{p.notes}</dd>
          </>
        )}
      </dl>
    </div>
  );
}
