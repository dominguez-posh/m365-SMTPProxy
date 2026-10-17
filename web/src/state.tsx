// App state: signed-in user (with the state of the second factor) and toasts.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { CurrentUser } from "../../shared/types";
import { api } from "./api";
import { createPasskey, getPasskey } from "./webauthn";

type Toast = { id: number; text: string; kind: "ok" | "error" | "info" };

interface AppState {
  user: CurrentUser | null | undefined;
  setupRequired: boolean;
  setUser: (u: CurrentUser | null) => void;
  refreshUser: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  loginPasskey: () => Promise<void>;
  logout: () => Promise<void>;
  toasts: Toast[];
  toast: (text: string, kind?: Toast["kind"]) => void;
  dismissToast: (id: number) => void;
}

const Ctx = createContext<AppState>(null!);
export const useApp = () => useContext(Ctx);

export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null | undefined>(undefined);
  const [setupRequired, setSetupRequired] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const refreshUser = useCallback(async () => {
    try {
      setUser(await api<CurrentUser>("GET", "/auth/session"));
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    api<{ required: boolean }>("GET", "/setup")
      .then((s) => {
        setSetupRequired(s.required);
        return s.required ? setUser(null) : refreshUser();
      })
      .catch(() => setUser(null));
    const out = () => setUser(null);
    addEventListener("smtpproxy:logout", out);
    return () => removeEventListener("smtpproxy:logout", out);
  }, []);

  const toast = useCallback((text: string, kind: Toast["kind"] = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 8000 : 4000);
  }, []);

  const value: AppState = {
    user,
    setupRequired,
    setUser: (u) => {
      setSetupRequired(false);
      setUser(u);
    },
    refreshUser,
    login: async (username, password) => setUser(await api<CurrentUser>("POST", "/auth/login", { username, password })),
    loginPasskey: async () => {
      const o = await api<any>("POST", "/auth/passkey/login/options");
      const credential = await getPasskey(o);
      setUser(await api<CurrentUser>("POST", "/auth/passkey/login", { challengeId: o.challengeId, credential }));
    },
    logout: async () => {
      await api("POST", "/auth/logout").catch(() => undefined);
      setUser(null);
      location.hash = "#/";
    },
    toasts,
    toast,
    dismissToast: (id) => setToasts((t) => t.filter((x) => x.id !== id)),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/* ------------------------------------------------------------------ second factor calls */
export const mfa = {
  setup: () => api<{ secret: string; uri: string; issuer: string; account: string }>("POST", "/auth/mfa/setup"),
  confirm: (code: string) => api<{ user: CurrentUser; recoveryCodes?: string[] }>("POST", "/auth/mfa/setup/confirm", { code }),
  verify: (code: string) => api<CurrentUser>("POST", "/auth/mfa/verify", { code }),
  removeTotp: () => api<CurrentUser>("DELETE", "/auth/mfa/totp"),
  recoveryCodes: async (input: string | { passkey: true }) => {
    if (typeof input === "string") return api<{ recoveryCodes: string[]; user: CurrentUser }>("POST", "/auth/mfa/recovery-codes", { code: input });
    const credential = await getPasskey(await api("POST", "/auth/passkey/verify/options"));
    return api<{ recoveryCodes: string[]; user: CurrentUser }>("POST", "/auth/mfa/recovery-codes", { credential });
  },
  registerPasskey: async (name: string) => {
    const credential = await createPasskey(await api("POST", "/auth/passkey/register/options"));
    return api<{ user: CurrentUser; recoveryCodes?: string[] }>("POST", "/auth/passkey/register/verify", { credential, name });
  },
  verifyPasskey: async () => {
    const credential = await getPasskey(await api("POST", "/auth/passkey/verify/options"));
    return api<CurrentUser>("POST", "/auth/passkey/verify", { credential });
  },
  renamePasskey: (id: string, name: string) => api<CurrentUser>("PATCH", `/auth/passkeys/${encodeURIComponent(id)}`, { name }),
  deletePasskey: (id: string) => api<CurrentUser>("DELETE", `/auth/passkeys/${encodeURIComponent(id)}`),
};
