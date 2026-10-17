// Browser side of passkeys (from hrdnr): JSON options of the server (base64url) to the WebAuthn API and back.
import { ApiError } from "./api";

const toBuf = (s: string) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const toB64u = (b: ArrayBuffer | null) =>
  b ? btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : null;

export const passkeySupported = () => typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials;

const descriptors = (list: any[] | undefined) => (list ?? []).map((c) => ({ ...c, id: toBuf(c.id) }));

/** cancelled or refused by the browser: understandable message instead of a DOMException */
function browserError(e: unknown): never {
  const name = (e as DOMException)?.name;
  if (name === "NotAllowedError" || name === "AbortError") throw new ApiError(400, "Der Vorgang wurde abgebrochen oder ist abgelaufen.");
  if (name === "InvalidStateError") throw new ApiError(409, "Dieser Passkey ist für das Konto schon registriert.");
  if (name === "SecurityError") throw new ApiError(400, "Der Browser erlaubt Passkeys für diese Adresse nicht (HTTPS und eine Domäne sind nötig).");
  throw new ApiError(400, `Passkey: ${(e as Error)?.message ?? String(e)}`);
}

export async function createPasskey(o: any) {
  if (!passkeySupported()) throw new ApiError(400, "Dieser Browser unterstützt keine Passkeys.");
  let c: PublicKeyCredential;
  try {
    c = (await navigator.credentials.create({
      publicKey: { ...o, challenge: toBuf(o.challenge), user: { ...o.user, id: toBuf(o.user.id) }, excludeCredentials: descriptors(o.excludeCredentials) },
    })) as PublicKeyCredential;
  } catch (e) {
    browserError(e);
  }
  const r = c.response as AuthenticatorAttestationResponse;
  return {
    id: c.id,
    rawId: toB64u(c.rawId),
    type: c.type,
    response: { clientDataJSON: toB64u(r.clientDataJSON), attestationObject: toB64u(r.attestationObject), transports: r.getTransports?.() ?? [] },
    clientExtensionResults: c.getClientExtensionResults() as any,
  };
}

export async function getPasskey(o: any) {
  if (!passkeySupported()) throw new ApiError(400, "Dieser Browser unterstützt keine Passkeys.");
  let c: PublicKeyCredential;
  try {
    c = (await navigator.credentials.get({ publicKey: { ...o, challenge: toBuf(o.challenge), allowCredentials: descriptors(o.allowCredentials) } })) as PublicKeyCredential;
  } catch (e) {
    browserError(e);
  }
  const r = c.response as AuthenticatorAssertionResponse;
  return {
    id: c.id,
    rawId: toB64u(c.rawId),
    type: c.type,
    response: { clientDataJSON: toB64u(r.clientDataJSON), authenticatorData: toB64u(r.authenticatorData), signature: toB64u(r.signature), userHandle: toB64u(r.userHandle) },
  };
}
