// Types shared by server and web app. Field names follow the JSON of the proxy (camelCase).

export type ProxyState = "pending" | "approved" | "rejected";

export interface SmtpUser {
  name: string;
  passwordHash?: string;
  enabled: boolean;
  description: string;
  allowedSenders: string[];
  /** only from the web app to the server: set a new password (the server stores the hash) */
  newPassword?: string;
}

export interface ProxyConfig {
  revision: number;
  modifiedAt: string;
  modifiedBy: string;
  smtp: {
    enabled: boolean;
    listenAddress: string;
    port: number;
    hostName: string;
    maxMessageSizeMb: number;
    maxRecipients: number;
    anonymousNetworks: string[];
    allowedNetworks: string[];
    allowAuthWithoutTls: boolean;
  };
  users: SmtpUser[];
  senders: {
    allowedAddresses: string[];
    allowedDomains: string[];
    exchangeScopeEnabled: boolean;
    exchangeScopeGroup: string;
    exchangeScopeSyncedAt?: string | null;
  };
  m365: {
    tenantId: string;
    tenantName: string;
    clientId: string;
    certificateThumbprint: string;
    certificateExpires?: string | null;
    domains: string[];
    connectedAt?: string | null;
    connectedBy: string;
  };
  delivery: { retryHours: number; logRetentionDays: number; logSubjects: boolean };
  management: { serverUrl: string; acceptUpdates: boolean; acceptRemoteConfig: boolean };
}

export interface ServiceStatus {
  version: string;
  host: string;
  startedAt: string;
  updatedAt: string;
  listeningOn?: string | null;
  smtpError?: string | null;
  activeSessions: number;
  queueLength: number;
  failedCount: number;
  deliveredSinceStart: number;
  failedSinceStart: number;
  lastDelivery?: string | null;
  lastDeliveryError?: string | null;
  m365Connected: boolean;
  m365Error?: string | null;
  configRevision: number;
}

export interface QueueItem {
  id: string;
  receivedAt: string;
  clientIp: string;
  user?: string | null;
  from: string;
  recipients: string[];
  size: number;
  subject?: string | null;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string | null;
}

export interface MailLogEntry {
  seq: number;
  time: string;
  event: "received" | "delivered" | "deferred" | "failed" | "refused";
  id?: string | null;
  clientIp?: string | null;
  user?: string | null;
  from?: string | null;
  to: string[];
  size: number;
  subject?: string | null;
  attempt: number;
  detail?: string | null;
}

export interface ServiceLogEntry {
  seq: number;
  time: string;
  level: "info" | "warn" | "error";
  message: string;
}

export interface Command {
  id: string;
  type: "retryFailed" | "deleteFailed" | "retryQueue";
  arg?: string;
  createdAt: string;
  createdBy: string;
}

/** a proxy as the web app sees it */
export interface Proxy {
  id: string;
  name: string;
  host: string;
  domain?: string;
  os?: string;
  version: string;
  state: ProxyState;
  fingerprint: string;
  keyStorage: string;
  registeredAt: string;
  approvedAt?: string;
  approvedBy?: string;
  lastSeen?: string;
  lastIp?: string;
  notes?: string;
  status?: ServiceStatus;
  config?: ProxyConfig;
  queue?: QueueItem[];
  failed?: QueueItem[];
  desired?: { baseRevision: number; config: ProxyConfig; by: string; at: string };
  desiredError?: { message: string; at: string };
  updateTarget?: string;
  pendingCommands: Command[];
}

export interface Overview {
  productName: string;
  package?: { version: string; sha256: string; size: number; builtAt: string };
  autoUpdate: boolean;
  installCommand: string;
  publicUrl: string;
}

export interface EventEntry {
  id: string;
  at: string;
  by: string;
  proxyId?: string;
  proxyName?: string;
  action: string;
  detail?: string;
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  createdAt: string;
}
