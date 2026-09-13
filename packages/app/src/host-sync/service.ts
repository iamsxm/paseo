import PocketBase, {
  BaseAuthStore,
  ClientResponseError,
  isTokenExpired,
} from "pocketbase";
import { z } from "zod";
import type { HostProfile } from "@/types/host-connection";
import {
  acceptResponse,
  captureChanges,
  CheckpointSchema,
  emptyCheckpoint,
  overlayPending,
  projectRelayHosts,
  SyncResponseSchema,
  type Checkpoint,
  type HostRecord,
  type HostChange,
} from "./model";

const STORAGE_KEY = "@paseo:host-sync:v1";
const UserSchema = z.object({
  id: z.string().min(1),
  email: z.string(),
  collectionId: z.string(),
  collectionName: z.literal("sync_users"),
});
const SessionSchema = z.object({
  endpoint: z.string().url(),
  token: z.string(),
  user: UserSchema,
});
const SavedSchema = z.object({
  endpoint: z.string(),
  session: SessionSchema.nullable(),
  accounts: z.record(z.string(), CheckpointSchema),
});
type Saved = z.infer<typeof SavedSchema>;
type Session = z.infer<typeof SessionSchema>;

export interface SyncStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}
export interface SyncHostRegistry {
  boot(): Promise<void>;
  getHosts(): HostProfile[];
  subscribeHostList(listener: () => void): () => void;
  applySyncedRelayHosts(records: HostRecord[]): Promise<void>;
}
export interface SyncSnapshot {
  status:
    | "loading"
    | "signedOut"
    | "ready"
    | "syncing"
    | "offline"
    | "expired"
    | "error";
  endpoint: string;
  email: string | null;
  pending: number;
  conflicts: number;
  lastSyncedAt: number | null;
}

export function normalizeSyncEndpoint(value: string): string {
  const url = new URL(value.trim());
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Invalid sync service URL");
  }
  return url.toString().replace(/\/+$/, "");
}

// 目录同步独立于 daemon 数据流；单个队列负责持久化和网络往返。
export class HostSyncService {
  private saved: Saved = { endpoint: "", session: null, accounts: {} };
  private snapshot: SyncSnapshot = {
    status: "loading",
    endpoint: "",
    email: null,
    pending: 0,
    conflicts: 0,
    lastSyncedAt: null,
  };
  private listeners = new Set<() => void>();
  private client: PocketBase | null = null;
  private started: Promise<void> | null = null;
  private inFlight: Promise<void> | null = null;
  private persistence: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  private applying = false;
  private active = false;
  private requested = false;

  constructor(
    private readonly storage: SyncStorage,
    private readonly registry: SyncHostRegistry
  ) {}

  getSnapshot = (): SyncSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private accountKey(session: Session): string {
    return JSON.stringify([session.endpoint, session.user.id]);
  }

  private checkpoint(): Checkpoint {
    const session = this.saved.session;
    if (!session) return emptyCheckpoint();
    return this.saved.accounts[this.accountKey(session)] ?? emptyCheckpoint();
  }

  private setCheckpoint(checkpoint: Checkpoint): void {
    const session = this.saved.session;
    if (session) this.saved.accounts[this.accountKey(session)] = checkpoint;
  }

  private publish(patch: Partial<SyncSnapshot>): void {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      endpoint: this.saved.endpoint,
      email: this.saved.session?.user.email ?? null,
      pending: this.checkpoint().pending.length,
    };
    for (const listener of this.listeners) listener();
  }

  private persist(): Promise<void> {
    const data = JSON.stringify(this.saved);
    const write = this.persistence
      .catch(() => undefined)
      .then(() => this.storage.setItem(STORAGE_KEY, data));
    this.persistence = write;
    return write;
  }

  async start(): Promise<void> {
    this.active = true;
    this.started ??= this.restore();
    await this.started;
    if (!this.active || this.timer) return;
    this.unsubscribe = this.registry.subscribeHostList(() =>
      this.onHostsChanged()
    );
    this.timer = setInterval(() => {
      void this.sync();
    }, 10_000);
    void this.sync();
  }

  stop(): void {
    this.active = false;
    this.generation += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private async restore(): Promise<void> {
    try {
      await this.registry.boot();
      const raw = await this.storage.getItem(STORAGE_KEY);
      if (raw) this.saved = SavedSchema.parse(JSON.parse(raw));
      if (this.saved.session)
        this.client = this.createClient(this.saved.session);
      this.publish({ status: this.client ? "ready" : "signedOut" });
    } catch {
      this.publish({ status: "error" });
    }
  }

  private createClient(session: Session): PocketBase {
    const auth = new BaseAuthStore();
    auth.save(session.token, session.user);
    return new PocketBase(session.endpoint, auth);
  }

  async signIn(input: {
    endpoint: string;
    email: string;
    password: string;
  }): Promise<void> {
    await this.start();
    if (this.saved.session)
      throw new Error("Sign out before changing accounts");
    const endpoint = normalizeSyncEndpoint(input.endpoint);
    const client = new PocketBase(endpoint, new BaseAuthStore());
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 15_000);
    const result = await client
      .collection("sync_users")
      .authWithPassword(input.email.trim(), input.password, {
        signal: abort.signal,
      })
      .finally(() => clearTimeout(timeout));
    await this.acceptAuthentication(endpoint, client, result);
  }

  // 必须在点击事件中立即启动官方 OAuth 弹窗，避免 Safari 将其识别为异步弹窗并拦截。
  signInWithGitHub(inputEndpoint: string): Promise<void> {
    if (this.saved.session) {
      return Promise.reject(new Error("Sign out before changing accounts"));
    }
    const endpoint = normalizeSyncEndpoint(inputEndpoint);
    const client = new PocketBase(endpoint, new BaseAuthStore());
    return client
      .collection("sync_users")
      .authWithOAuth2({ provider: "github" })
      .then((result) => this.acceptAuthentication(endpoint, client, result));
  }

  private async acceptAuthentication(
    endpoint: string,
    client: PocketBase,
    result: { token: string; record: unknown }
  ): Promise<void> {
    const user = UserSchema.parse(result.record);
    this.generation += 1;
    this.saved.endpoint = endpoint;
    this.saved.session = { endpoint, token: result.token, user };
    this.client = client;
    try {
      await this.persist();
    } catch (error) {
      this.saved.session = null;
      this.client = null;
      this.publish({ status: "error" });
      throw error;
    }
    this.publish({ status: "ready", conflicts: 0, lastSyncedAt: null });
    // 再次登录恢复该账号未发送的修改，不能把退出时移除的主机解释为删除。
    const checkpoint = this.checkpoint();
    if (checkpoint.initialized) await this.apply(overlayPending(checkpoint));
    await this.sync();
  }

  async signOut(): Promise<void> {
    this.generation += 1;
    this.requested = false;
    const checkpoint = this.checkpoint();
    const removals = overlayPending(checkpoint).map((record) => ({
      serverId: record.serverId,
      revision: record.revision,
      profile: null,
    }));
    this.client?.cancelAllRequests();
    this.client = null;
    if (this.saved.session)
      delete this.saved.accounts[this.accountKey(this.saved.session)];
    this.saved.session = null;
    await this.apply(removals);
    await this.persist();
    this.publish({ status: "signedOut", conflicts: 0, lastSyncedAt: null });
  }

  private onHostsChanged(): void {
    if (this.applying || !this.saved.session) return;
    const checkpoint = this.checkpoint();
    if (!checkpoint.initialized) return;
    this.setCheckpoint({
      ...checkpoint,
      pending: captureChanges(checkpoint, this.registry.getHosts()),
    });
    this.publish({});
    void this.persist()
      .then(() => this.sync())
      .catch(() => this.publish({ status: "error" }));
  }

  private async apply(records: HostRecord[]): Promise<void> {
    this.applying = true;
    let application: Promise<void>;
    try {
      application = this.registry.applySyncedRelayHosts(records);
    } finally {
      this.applying = false;
    }
    await application;
  }

  sync(): Promise<void> {
    if (!this.client || !this.saved.session || !this.active)
      return Promise.resolve();
    if (this.inFlight) {
      this.requested = true;
      return this.inFlight;
    }
    const generation = this.generation;
    this.inFlight = this.performSync(generation).finally(() => {
      this.inFlight = null;
      if (this.requested) {
        this.requested = false;
        void this.sync();
      }
    });
    return this.inFlight;
  }

  private async performSync(generation: number): Promise<void> {
    const client = this.client;
    const session = this.saved.session;
    if (!client || !session) return;
    this.publish({ status: "syncing" });
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 15_000);
    try {
      if (!client.authStore.isValid) {
        this.publish({ status: "expired" });
        return;
      }
      if (isTokenExpired(client.authStore.token, 3600)) {
        const refreshed = await client
          .collection("sync_users")
          .authRefresh({ signal: abort.signal });
        if (generation !== this.generation) return;
        session.token = refreshed.token;
        session.user = UserSchema.parse(refreshed.record);
        await this.persist();
      }
      let checkpoint = this.checkpoint();
      let sent: HostChange[] = [];
      if (checkpoint.initialized) {
        checkpoint = {
          ...checkpoint,
          pending: captureChanges(checkpoint, this.registry.getHosts()),
        };
        this.setCheckpoint(checkpoint);
        sent = checkpoint.pending.slice(0, 500);
      }
      await this.persist();
      const response = SyncResponseSchema.parse(
        await client.send("/api/paseo/hosts/sync", {
          method: "POST",
          body: { changes: sent },
          signal: abort.signal,
          requestKey: null,
        })
      );
      if (generation !== this.generation) return;
      checkpoint = this.checkpoint();
      if (!checkpoint.initialized) {
        const known = new Set(
          response.records.map((record) => record.serverId)
        );
        const pending: HostChange[] = [];
        for (const [serverId, profile] of projectRelayHosts(
          this.registry.getHosts()
        )) {
          if (!known.has(serverId))
            pending.push({ serverId, profile, baseRevision: 0 });
        }
        checkpoint = { records: response.records, pending, initialized: true };
      } else {
        checkpoint = acceptResponse(checkpoint, sent, response);
      }
      this.setCheckpoint(checkpoint);
      await this.apply(overlayPending(checkpoint));
      await this.persist();
      if (generation !== this.generation) return;
      this.publish({
        status: "ready",
        conflicts: response.conflicts.length,
        lastSyncedAt: Date.now(),
      });
      if (checkpoint.pending.length > 0) this.requested = true;
    } catch (error) {
      if (generation !== this.generation) return;
      const expired =
        error instanceof ClientResponseError &&
        (error.status === 401 || error.status === 403);
      this.publish({ status: expired ? "expired" : "offline" });
    } finally {
      clearTimeout(timeout);
    }
  }
}
