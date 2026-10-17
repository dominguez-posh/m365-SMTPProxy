// Calls to the management server. Non-GET requests carry the CSRF header the server expects.
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch("/api" + path, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(method !== "GET" ? { "X-Requested-With": "smtpproxy" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== "/auth/login") window.dispatchEvent(new Event("smtpproxy:logout"));
    throw new ApiError(res.status, data.error ?? res.statusText);
  }
  return data as T;
}

export const fmtDate = (s?: string | null) => (s ? new Date(s).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" }) : "–");
export const fmtTime = (s?: string | null) => (s ? new Date(s).toLocaleTimeString("de-DE") : "–");
export function ago(s?: string | null) {
  if (!s) return "nie";
  const sec = Math.round((Date.now() - Date.parse(s)) / 1000);
  if (sec < 60) return "gerade eben";
  if (sec < 3600) return `vor ${Math.round(sec / 60)} Min.`;
  if (sec < 86400) return `vor ${Math.round(sec / 3600)} Std.`;
  return `vor ${Math.round(sec / 86400)} Tagen`;
}
/** random password for SMTP users (no ambiguous characters) */
export function randomPassword(len = 20) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const v = crypto.getRandomValues(new Uint32Array(len));
  const pw = Array.from(v, (x) => chars[x % chars.length]).join("");
  // the server requires more than letters only
  return /\d/.test(pw) ? pw : pw.slice(0, -1) + "7";
}
