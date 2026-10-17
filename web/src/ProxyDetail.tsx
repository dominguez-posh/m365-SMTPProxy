import { useEffect, useState } from "react";
import type { MailLogEntry, Overview, Proxy, ProxyConfig, QueueItem, ServiceLogEntry, SmtpUser } from "../../shared/types";
import { ago, api, fmtDate, fmtTime, randomPassword } from "./api";
import { Health, online } from "./ProxyList";

type Tab = "status" | "config" | "queue" | "log" | "info";

export function ProxyDetail({ id }: { id: string }) {
  const [p, setP] = useState<Proxy>();
  const [ov, setOv] = useState<Overview>();
  const [tab, setTab] = useState<Tab>("status");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");

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
    setMsg("");
    try {
      const r = await fn();
      if (r && typeof r === "object" && "id" in r) setP(r);
      if (ok) setMsg(ok);
      setError("");
      return true;
    } catch (e: any) {
      setError(e.message);
      return false;
    }
  };

  if (!p) return error ? <div className="msg err">{error}</div> : null;
  const s = p.status;
  const pkg = ov?.package;

  return (
    <>
      <p className="sub" style={{ margin: 0 }}>
        <a href="#/">Proxys</a> /
      </p>
      <div className="between">
        <div>
          <h1>
            {p.name} <Health p={p} />
          </h1>
          <p className="sub">
            {p.host}
            {p.domain ? ` · ${p.domain}` : ""} · Version {p.version} · letzter Kontakt {ago(p.lastSeen)}
          </p>
        </div>
        <div className="row">
          {p.state === "pending" && (
            <button className="primary" onClick={() => act(() => api("POST", `/proxies/${p.id}/approve`), "Freigegeben.")}>
              Freigeben
            </button>
          )}
          {p.state === "approved" && pkg && pkg.version !== p.version && !p.updateTarget && (
            <button onClick={() => act(() => api("POST", `/proxies/${p.id}/update`), `Update auf ${pkg.version} ausgerollt; der Proxy installiert es beim nächsten Kontakt.`)}>
              Update auf {pkg.version}
            </button>
          )}
          <button
            onClick={() => {
              const name = prompt("Anzeigename", p.name);
              if (name) act(() => api("PATCH", `/proxies/${p.id}`, { name }));
            }}
          >
            Umbenennen
          </button>
          <button
            className="danger"
            onClick={async () => {
              if (!confirm(`${p.name} vom Server entfernen? Der Proxy läuft weiter und meldet sich neu an (erneute Freigabe nötig), solange die Serveradresse eingetragen ist.`)) return;
              if (await act(() => api("DELETE", `/proxies/${p.id}`))) location.hash = "#/";
            }}
          >
            Entfernen
          </button>
        </div>
      </div>
      {error && <div className="msg err">{error}</div>}
      {msg && <div className="msg ok">{msg}</div>}
      {p.updateTarget && <div className="msg info">Update auf {p.updateTarget} ist ausgerollt und wird beim nächsten Kontakt installiert{p.config?.management.acceptUpdates === false ? " – der Proxy nimmt aber keine Updates an (Einstellung am Proxy)" : ""}.</div>}
      {p.desired && <div className="msg info">Geänderte Einstellungen von {p.desired.by} ({fmtDate(p.desired.at)}) warten auf Übernahme durch den Proxy.</div>}
      {p.desiredError && <div className="msg warn">Einstellungen wurden nicht übernommen: {p.desiredError.message} ({fmtDate(p.desiredError.at)})</div>}

      <div className="tabs">
        {(
          [
            ["status", "Status"],
            ["config", "Einstellungen"],
            ["queue", `Warteschlange${s ? ` (${s.queueLength}/${s.failedCount})` : ""}`],
            ["log", "Protokoll"],
            ["info", "Info"],
          ] as [Tab, string][]
        ).map(([k, l]) => (
          <button key={k} className={"tab" + (tab === k ? " active" : "")} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>

      {p.state !== "approved" ? (
        <div className="msg info">Status, Einstellungen und Protokolle sind sichtbar, sobald der Proxy freigegeben ist.</div>
      ) : tab === "status" ? (
        <StatusTab p={p} />
      ) : tab === "config" ? (
        p.config ? <ConfigTab p={p} onSaved={(x, info) => (setP(x), setMsg(info))} onError={setError} /> : <div className="empty">Noch keine Einstellungen gemeldet.</div>
      ) : tab === "queue" ? (
        <QueueTab p={p} act={act} />
      ) : tab === "log" ? (
        <LogTab id={p.id} />
      ) : (
        <InfoTab p={p} />
      )}
    </>
  );
}

function StatusTab({ p }: { p: Proxy }) {
  const s = p.status;
  if (!s) return <div className="empty">Noch kein Status gemeldet.</div>;
  const c = p.config;
  const card = (k: string, v: React.ReactNode, d?: React.ReactNode) => (
    <div className="card">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      {d && <div className="d">{d}</div>}
    </div>
  );
  return (
    <div className="cards">
      {card("Dienst", online(p) ? "Läuft" : "Offline", `gestartet ${fmtDate(s.startedAt)} · Meldung ${ago(s.updatedAt)}`)}
      {card("SMTP", s.listeningOn ?? "Lauscht nicht", s.smtpError ?? `${s.activeSessions} aktive Verbindungen`)}
      {card("Microsoft 365", s.m365Connected ? "Verbunden" : "Nicht verbunden", s.m365Error ?? (c?.m365.tenantName ? `${c.m365.tenantName} · Zertifikat bis ${fmtDate(c.m365.certificateExpires)}` : undefined))}
      {card("Warteschlange", `${s.queueLength} wartend`, `${s.failedCount} fehlgeschlagen`)}
      {card("Seit Start", `${s.deliveredSinceStart} zugestellt`, `${s.failedSinceStart} fehlgeschlagen · letzte Zustellung ${fmtDate(s.lastDelivery)}`)}
      {s.lastDeliveryError && card("Letzter Zustellfehler", "", s.lastDeliveryError)}
      {c && card("Absender", c.senders.exchangeScopeEnabled ? "In Exchange eingeschränkt" : "Nur im Proxy geprüft", `${c.senders.allowedAddresses.length} Adressen, ${c.senders.allowedDomains.length} Domänen`)}
      {c && card("Domänen", c.m365.domains.length, c.m365.domains.join(", "))}
    </div>
  );
}

const lines = (l: string[]) => l.join("\n");
const fromLines = (s: string) => [...new Set(s.split(/[\r\n,;]+/).map((x) => x.trim()).filter(Boolean))];

function ConfigTab({ p, onSaved, onError }: { p: Proxy; onSaved: (p: Proxy, info: string) => void; onError: (e: string) => void }) {
  const base = p.desired?.config ?? p.config!;
  const [c, setC] = useState<ProxyConfig>(() => structuredClone(base));
  const [text, setText] = useState(() => ({
    anon: lines(base.smtp.anonymousNetworks),
    allowed: lines(base.smtp.allowedNetworks),
    addresses: lines(base.senders.allowedAddresses),
    domains: lines(base.senders.allowedDomains),
  }));
  const [users, setUsers] = useState<(SmtpUser & { senders: string })[]>(() => base.users.map((u) => ({ ...u, senders: u.allowedSenders.join(", ") })));
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<{ name: string; password: string }[]>([]);

  const smtp = <K extends keyof ProxyConfig["smtp"]>(k: K, v: ProxyConfig["smtp"][K]) => setC({ ...c, smtp: { ...c.smtp, [k]: v } });

  const save = async () => {
    setBusy(true);
    const next: ProxyConfig = {
      ...c,
      smtp: { ...c.smtp, port: Number(c.smtp.port), maxMessageSizeMb: Number(c.smtp.maxMessageSizeMb), maxRecipients: Number(c.smtp.maxRecipients), anonymousNetworks: fromLines(text.anon), allowedNetworks: fromLines(text.allowed) },
      senders: { ...c.senders, allowedAddresses: fromLines(text.addresses).map((x) => x.toLowerCase()), allowedDomains: fromLines(text.domains).map((x) => x.replace(/^@/, "").toLowerCase()) },
      users: users.map(({ senders, ...u }) => ({ ...u, allowedSenders: fromLines(senders).map((x) => x.toLowerCase()) })),
    };
    try {
      const x = await api<Proxy>("PUT", `/proxies/${p.id}/config`, { config: next });
      const pw = users.filter((u) => u.newPassword).map((u) => ({ name: u.name, password: u.newPassword! }));
      setShown(pw);
      setUsers(users.map(({ newPassword, ...u }) => u));
      const exo = c.senders.exchangeScopeEnabled && lines(next.senders.allowedAddresses) !== lines(base.senders.allowedAddresses);
      onSaved(x, "Gespeichert. Der Proxy übernimmt die Einstellungen beim nächsten Kontakt (innerhalb von etwa 30 Sekunden)." + (exo ? " Hinweis: Die Exchange-Einschränkung muss am Proxy abgeglichen werden (Oberfläche → Microsoft 365 → Absender in Exchange abgleichen)." : ""));
    } catch (e: any) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {shown.length > 0 && (
        <div className="msg warn">
          Neue Passwörter (nur jetzt sichtbar):
          {shown.map((x) => (
            <div key={x.name}>
              {x.name}: <code>{x.password}</code>
            </div>
          ))}
        </div>
      )}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>SMTP-Empfang</h3>
        <label className="check">
          <input type="checkbox" checked={c.smtp.enabled} onChange={(e) => smtp("enabled", e.target.checked)} /> SMTP-Empfang aktiv
        </label>
        <div className="grid2">
          <label className="f">
            <span>IP-Adresse</span>
            <input value={c.smtp.listenAddress} onChange={(e) => smtp("listenAddress", e.target.value)} />
          </label>
          <label className="f">
            <span>Port</span>
            <input type="number" value={c.smtp.port} onChange={(e) => smtp("port", Number(e.target.value))} />
          </label>
          <label className="f">
            <span>Maximale Größe (MB)</span>
            <input type="number" value={c.smtp.maxMessageSizeMb} onChange={(e) => smtp("maxMessageSizeMb", Number(e.target.value))} />
          </label>
          <label className="f">
            <span>Maximale Empfänger</span>
            <input type="number" value={c.smtp.maxRecipients} onChange={(e) => smtp("maxRecipients", Number(e.target.value))} />
          </label>
          <label className="f">
            <span>Netze ohne Anmeldung (anonym)</span>
            <textarea value={text.anon} onChange={(e) => setText({ ...text, anon: e.target.value })} />
          </label>
          <label className="f">
            <span>Zugelassene Netze (leer = alle)</span>
            <textarea value={text.allowed} onChange={(e) => setText({ ...text, allowed: e.target.value })} />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={c.smtp.allowAuthWithoutTls} onChange={(e) => smtp("allowAuthWithoutTls", e.target.checked)} /> Anmeldung (AUTH) ohne TLS erlauben
        </label>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <h3 style={{ marginTop: 0 }}>Erlaubte Absender</h3>
        <p className="hint">Sind beide Listen leer, ist jede Adresse der Tenant-Domänen ({p.config!.m365.domains.join(", ") || "–"}) erlaubt.</p>
        <div className="grid2">
          <label className="f">
            <span>Adressen</span>
            <textarea value={text.addresses} onChange={(e) => setText({ ...text, addresses: e.target.value })} />
          </label>
          <label className="f">
            <span>Domänen</span>
            <textarea value={text.domains} onChange={(e) => setText({ ...text, domains: e.target.value })} />
          </label>
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="between">
          <h3 style={{ marginTop: 0 }}>SMTP-Benutzer</h3>
          <button
            onClick={() => {
              const name = prompt("Benutzername");
              if (name?.trim()) setUsers([...users, { name: name.trim(), enabled: true, description: "", allowedSenders: [], senders: "", newPassword: randomPassword() }]);
            }}
          >
            Benutzer hinzufügen
          </button>
        </div>
        {users.length === 0 ? (
          <p className="hint">Keine SMTP-Benutzer.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
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
                        <b>{u.name}</b>
                        {u.newPassword && <div className="hint">neues Passwort beim Speichern</div>}
                      </td>
                      <td>
                        <input type="checkbox" checked={u.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
                      </td>
                      <td>
                        <input value={u.description} onChange={(e) => set({ description: e.target.value })} />
                      </td>
                      <td>
                        <input value={u.senders} onChange={(e) => set({ senders: e.target.value })} placeholder="alle erlaubten" />
                      </td>
                      <td>
                        <div className="row">
                          <button onClick={() => set({ newPassword: randomPassword() })}>Neues Passwort</button>
                          <button className="danger" onClick={() => setUsers(users.filter((_, j) => j !== i))}>
                            Löschen
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

      <div className="card" style={{ marginTop: 12 }}>
        <h3 style={{ marginTop: 0 }}>Zustellung und Verwaltung</h3>
        <div className="grid2">
          <label className="f">
            <span>Wiederholen bis (Stunden)</span>
            <input type="number" value={c.delivery.retryHours} onChange={(e) => setC({ ...c, delivery: { ...c.delivery, retryHours: Number(e.target.value) } })} />
          </label>
          <label className="f">
            <span>Protokolle aufbewahren (Tage)</span>
            <input type="number" value={c.delivery.logRetentionDays} onChange={(e) => setC({ ...c, delivery: { ...c.delivery, logRetentionDays: Number(e.target.value) } })} />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={c.delivery.logSubjects} onChange={(e) => setC({ ...c, delivery: { ...c.delivery, logSubjects: e.target.checked } })} /> Betreffzeilen protokollieren (personenbezogene Daten)
        </label>
        <label className="check">
          <input type="checkbox" checked={c.management.acceptUpdates} onChange={(e) => setC({ ...c, management: { ...c.management, acceptUpdates: e.target.checked } })} /> Updates vom Server installieren
        </label>
        <p className="hint">Microsoft-365-Verbindung, Exchange-Einschränkung und Serveradresse lassen sich nur am Proxy selbst ändern.</p>
      </div>

      <div className="row end" style={{ marginTop: 16 }}>
        {p.desired && (
          <button onClick={async () => onSaved(await api("DELETE", `/proxies/${p.id}/config`), "Ausstehende Änderung verworfen.")}>Ausstehende Änderung verwerfen</button>
        )}
        <button className="primary" disabled={busy} onClick={save}>
          Speichern
        </button>
      </div>
    </>
  );
}

function QueueTab({ p, act }: { p: Proxy; act: (fn: () => Promise<any>, ok?: string) => Promise<boolean> }) {
  const cmd = (type: string, arg?: string) => act(() => api("POST", `/proxies/${p.id}/commands`, { type, arg }), "Befehl gesendet; der Proxy führt ihn beim nächsten Kontakt aus.");
  const table = (items: QueueItem[] | undefined, failed: boolean) =>
    !items?.length ? (
      <div className="empty">Keine Nachrichten.</div>
    ) : (
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Empfangen</th>
              <th>Absender</th>
              <th>Empfänger</th>
              <th>Versuche</th>
              <th>{failed ? "Fehler" : "Nächster Versuch / Fehler"}</th>
              {failed && <th />}
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <td>{fmtDate(i.receivedAt)}</td>
                <td>{i.from}</td>
                <td>{i.recipients.join(", ")}</td>
                <td>{i.attempts}</td>
                <td>
                  {!failed && <div>{fmtDate(i.nextAttemptAt)}</div>}
                  <div className="hint">{i.lastError}</div>
                </td>
                {failed && (
                  <td>
                    <div className="row">
                      <button onClick={() => cmd("retryFailed", i.id)}>Erneut senden</button>
                      <button className="danger" onClick={() => confirm("Nachricht endgültig löschen?") && cmd("deleteFailed", i.id)}>
                        Löschen
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
    <>
      {p.pendingCommands.length > 0 && <div className="msg info">{p.pendingCommands.length} Befehl(e) warten auf Ausführung.</div>}
      <div className="between">
        <h2 style={{ marginTop: 0 }}>Warteschlange</h2>
        <button onClick={() => cmd("retryQueue")}>Alle sofort versuchen</button>
      </div>
      {table(p.queue, false)}
      <div className="between">
        <h2>Fehlgeschlagen</h2>
        {!!p.failed?.length && (
          <button style={{ marginTop: 16 }} onClick={() => cmd("retryFailed")}>
            Alle erneut senden
          </button>
        )}
      </div>
      {table(p.failed, true)}
    </>
  );
}

const EVENT: Record<string, [string, string]> = {
  received: ["Angenommen", "b-info"],
  delivered: ["Zugestellt", "b-ok"],
  deferred: ["Verzögert", "b-warn"],
  failed: ["Fehlgeschlagen", "b-bad"],
  refused: ["Abgewiesen", "b-bad"],
};

function LogTab({ id }: { id: string }) {
  const [kind, setKind] = useState<"mail" | "service">("mail");
  const [event, setEvent] = useState("");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<(MailLogEntry | ServiceLogEntry)[]>([]);
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
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <select value={kind} onChange={(e) => setKind(e.target.value as any)} style={{ width: 180 }}>
          <option value="mail">Nachrichten</option>
          <option value="service">Dienst</option>
        </select>
        {kind === "mail" && (
          <select value={event} onChange={(e) => setEvent(e.target.value)} style={{ width: 180 }}>
            <option value="">Alle Ereignisse</option>
            {Object.entries(EVENT).map(([k, [l]]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        )}
        <input placeholder="Suchen (Adresse, IP, Text)" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 280 }} />
      </div>
      {error && <div className="msg err">{error}</div>}
      <div className="table-wrap">
        <table>
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
                  <td style={{ whiteSpace: "nowrap" }}>{fmtDate(r.time)}</td>
                  <td>
                    <span className={"badge " + (EVENT[r.event]?.[1] ?? "b-muted")}>{EVENT[r.event]?.[0] ?? r.event}</span>
                  </td>
                  <td>
                    {r.clientIp}
                    {r.user && <div className="hint">{r.user}</div>}
                  </td>
                  <td>{r.from}</td>
                  <td>{r.to.join(", ")}</td>
                  <td>
                    {[r.subject, r.size ? `${(r.size / 1024).toFixed(1)} KB` : null, r.attempt > 1 ? `Versuch ${r.attempt}` : null].filter(Boolean).join(" · ")}
                    {r.detail && <div className="hint">{r.detail}</div>}
                  </td>
                </tr>
              ) : (
                <tr key={r.seq}>
                  <td style={{ whiteSpace: "nowrap" }}>{fmtDate(r.time)}</td>
                  <td>
                    <span className={"badge " + (r.level === "error" ? "b-bad" : r.level === "warn" ? "b-warn" : "b-muted")}>{r.level}</span>
                  </td>
                  <td>{r.message}</td>
                </tr>
              ),
            )}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  Keine Einträge.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function InfoTab({ p }: { p: Proxy }) {
  const c = p.config;
  const row = (k: string, v: React.ReactNode) => (
    <tr>
      <th style={{ width: 240 }}>{k}</th>
      <td>{v}</td>
    </tr>
  );
  return (
    <table>
      <tbody>
        {row("Kennung", <code>{p.id}</code>)}
        {row("Fingerabdruck", <code>{p.fingerprint}</code>)}
        {row("Schlüssel", p.keyStorage === "tpm" ? "TPM" : "Software (nicht exportierbar)")}
        {row("Betriebssystem", p.os)}
        {row("Registriert", fmtDate(p.registeredAt))}
        {row("Freigegeben", p.approvedAt ? `${fmtDate(p.approvedAt)} durch ${p.approvedBy}` : "–")}
        {row("Letzte Adresse", p.lastIp)}
        {row("Konfiguration", c ? `Revision ${c.revision}, geändert ${fmtDate(c.modifiedAt)} durch ${c.modifiedBy}` : "–")}
        {c && row("Tenant", `${c.m365.tenantName} (${c.m365.tenantId})`)}
        {c && row("App-ID", <code>{c.m365.clientId}</code>)}
        {c && row("Zertifikat", `${c.m365.certificateThumbprint} · gültig bis ${fmtDate(c.m365.certificateExpires)}`)}
        {c && row("Verbunden", `${fmtDate(c.m365.connectedAt)} durch ${c.m365.connectedBy}`)}
        {c && row("Exchange-Einschränkung", c.senders.exchangeScopeEnabled ? `Gruppe ${c.senders.exchangeScopeGroup}, abgeglichen ${fmtDate(c.senders.exchangeScopeSyncedAt)}` : "nein")}
        {row("Einstellungen vom Server", c?.management.acceptRemoteConfig ? "werden übernommen" : "werden nicht übernommen")}
        {p.notes && row("Notiz", p.notes)}
        {row("Status gemeldet", fmtTime(p.status?.updatedAt))}
      </tbody>
    </table>
  );
}
