import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import PocketBase from "pocketbase";
import {
  HostSyncService,
  type SyncHostRegistry,
  type SyncStorage,
} from "../../packages/app/src/host-sync/service";
import {
  mergeRelayHosts,
  SyncResponseSchema,
  type HostRecord,
  type SyncedProfile,
} from "../../packages/app/src/host-sync/model";
import type { HostProfile } from "../../packages/app/src/types/host-connection";

const password = "LocalFixturePassword12345";
const profile: SyncedProfile = {
  label: "VPS one",
  connections: [
    {
      relayEndpoint: "relay.example.com:443",
      useTls: true,
      daemonPublicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    },
  ],
};
let server: ChildProcess;
let endpoint: string;
let dataDirectory: string;
let token: string;
let tokenOther: string;
const services: HostSyncService[] = [];

async function sync(body: unknown, auth = token) {
  const response = await fetch(`${endpoint}/api/paseo/hosts/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

class Registry implements SyncHostRegistry {
  hosts: HostProfile[] = [];
  listeners = new Set<() => void>();
  async boot() {}
  getHosts() {
    return this.hosts;
  }
  subscribeHostList(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async applySyncedRelayHosts(records: HostRecord[]) {
    this.hosts = mergeRelayHosts(this.hosts, records);
    for (const listener of this.listeners) listener();
  }
  async edit(records: HostRecord[]) {
    await this.applySyncedRelayHosts(records);
  }
}

function device() {
  const registry = new Registry();
  const values = new Map<string, string>();
  const storage: SyncStorage = {
    async getItem(key) {
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      values.set(key, value);
    },
  };
  const service = new HostSyncService(storage, registry);
  services.push(service);
  return { service, registry, storage };
}

async function settled(service: HostSyncService) {
  await expect.poll(() => service.getSnapshot().status, { timeout: 5000 }).toBe("ready");
  await expect.poll(() => service.getSnapshot().pending, { timeout: 5000 }).toBe(0);
}

beforeAll(async () => {
  const binary = process.env.PASEO_HOST_SYNC_TEST_BINARY ?? "pocketbase";
  dataDirectory = mkdtempSync(path.join(tmpdir(), "paseo-host-sync-"));
  const prepared = spawnSync(
    binary,
    ["superuser", "upsert", "admin@example.test", password, "--dir", dataDirectory],
    { encoding: "utf8", windowsHide: true },
  );
  if (prepared.status !== 0)
    throw new Error(`PocketBase fixture setup failed: ${prepared.error ?? prepared.stderr}`);
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  endpoint = `http://127.0.0.1:${port}`;
  server = spawn(
    binary,
    [
      "serve",
      `--http=127.0.0.1:${port}`,
      "--dir",
      dataDirectory,
      "--migrationsDir",
      path.resolve("docker/host-sync/pb_migrations"),
      "--hooksDir",
      path.resolve("docker/host-sync/pb_hooks"),
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  await vi.waitFor(
    async () => {
      expect((await fetch(`${endpoint}/api/health`)).status).toBe(200);
    },
    { timeout: 10000 },
  );
  const admin = new PocketBase(endpoint);
  await admin.collection("_superusers").authWithPassword("admin@example.test", password);
  for (const email of ["owner@example.test", "other@example.test", "devices@example.test"]) {
    await admin.collection("sync_users").create({ email, password, passwordConfirm: password });
  }
  const owner = new PocketBase(endpoint);
  token = (await owner.collection("sync_users").authWithPassword("owner@example.test", password))
    .token;
  tokenOther = (
    await owner.collection("sync_users").authWithPassword("other@example.test", password)
  ).token;
}, 20000);

afterAll(async () => {
  for (const service of services) service.stop();
  if (server?.pid) {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
  if (dataDirectory) rmSync(dataDirectory, { recursive: true, force: true });
});

describe("real self-hosted PocketBase host sync", () => {
  it("requires a user and isolates account directories", async () => {
    expect((await sync({ changes: [] }, "")).status).toBe(401);
    const created = await sync({ changes: [{ serverId: "server-1", baseRevision: 0, profile }] });
    expect(created.status).toBe(200);
    expect(SyncResponseSchema.parse(created.body).records).toEqual([
      { serverId: "server-1", revision: 1, profile },
    ]);
    expect(
      SyncResponseSchema.parse((await sync({ changes: [] }, tokenOther)).body).records,
    ).toEqual([]);
  });

  it("retries are idempotent and stale writes cannot resurrect deletions", async () => {
    const create = { serverId: "delete-test", baseRevision: 0, profile };
    await sync({ changes: [create] });
    const retry = SyncResponseSchema.parse((await sync({ changes: [create] })).body);
    expect(retry.records.find((record) => record.serverId === create.serverId)?.revision).toBe(1);
    expect(retry.conflicts).toEqual([]);
    await sync({ changes: [{ ...create, baseRevision: 1, profile: null }] });
    const stale = SyncResponseSchema.parse(
      (
        await sync({
          changes: [{ ...create, baseRevision: 1, profile: { ...profile, label: "Old edit" } }],
        })
      ).body,
    );
    expect(stale.conflicts).toEqual([create.serverId]);
    expect(stale.records.find((record) => record.serverId === create.serverId)?.profile).toBeNull();
  });

  it("rejects non-relay configuration and invalid batches without partial writes", async () => {
    expect(
      (
        await sync({
          changes: [
            { serverId: "bad", baseRevision: 0, profile: { label: "Bad", connections: [] } },
          ],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await sync({
          changes: [
            { serverId: "duplicate", baseRevision: 0, profile },
            { serverId: "duplicate", baseRevision: 0, profile },
          ],
        })
      ).status,
    ).toBe(400);
    const directory = SyncResponseSchema.parse((await sync({ changes: [] })).body);
    expect(
      directory.records.some(
        (record) => record.serverId === "bad" || record.serverId === "duplicate",
      ),
    ).toBe(false);
  });

  it("serializes simultaneous edits with one version conflict", async () => {
    await sync({ changes: [{ serverId: "concurrent", baseRevision: 0, profile }] });
    const responses = await Promise.all(
      ["From A", "From B"].map((label) =>
        sync({
          changes: [{ serverId: "concurrent", baseRevision: 1, profile: { ...profile, label } }],
        }),
      ),
    );
    const parsed = responses.map((response) => SyncResponseSchema.parse(response.body));
    expect(parsed.flatMap((response) => response.conflicts)).toEqual(["concurrent"]);
    const final = SyncResponseSchema.parse((await sync({ changes: [] })).body);
    expect(final.records.find((record) => record.serverId === "concurrent")?.revision).toBe(2);
  });

  it("restores a persisted login and uploads edits made before restarting", async () => {
    const first = device();
    await first.service.signIn({ endpoint, email: "owner@example.test", password });
    await settled(first.service);
    first.service.stop();
    await first.registry.edit([{ serverId: "restart-host", revision: 1, profile }]);
    const restarted = new HostSyncService(first.storage, first.registry);
    services.push(restarted);
    await restarted.start();
    await settled(restarted);
    expect(restarted.getSnapshot().email).toBe("owner@example.test");
    const directory = SyncResponseSchema.parse((await sync({ changes: [] })).body);
    expect(directory.records.find((record) => record.serverId === "restart-host")?.profile).toEqual(
      profile,
    );
    await restarted.signOut();
    expect(first.registry.hosts).toEqual([]);
  });

  it("synchronizes three devices, restores offline edits, and isolates logout", async () => {
    const a = device();
    const b = device();
    const c = device();
    const first: HostRecord = { serverId: "vps-shared", revision: 1, profile };
    await a.registry.edit([first]);
    for (const current of [a, b, c]) {
      await current.service.signIn({ endpoint, email: "devices@example.test", password });
      await settled(current.service);
    }
    expect(b.registry.hosts[0].label).toBe(profile.label);
    expect(c.registry.hosts[0].serverId).toBe(first.serverId);
    c.service.stop();
    await c.registry.edit([{ ...first, profile: { ...profile, label: "Offline edit" } }]);
    await a.registry.edit([{ ...first, profile: { ...profile, label: "From A" } }]);
    await settled(a.service);
    await b.service.sync();
    expect(b.registry.hosts[0].label).toBe("From A");
    await b.registry.edit([{ ...first, profile: null }]);
    await settled(b.service);
    await c.service.start();
    await settled(c.service);
    expect(c.registry.hosts).toEqual([]);
    expect(c.service.getSnapshot().conflicts).toBe(1);
    await a.service.sync();
    expect(a.registry.hosts).toEqual([]);
    await a.registry.edit([{ ...first, serverId: "second-vps" }]);
    await settled(a.service);
    await a.service.signOut();
    expect(a.registry.hosts).toEqual([]);
    await a.service.signIn({ endpoint, email: "other@example.test", password });
    await settled(a.service);
    expect(a.registry.hosts).toEqual([]);
    await a.service.signOut();
    await a.service.signIn({ endpoint, email: "devices@example.test", password });
    await settled(a.service);
    expect(a.registry.hosts.map((host) => host.serverId)).toEqual(["second-vps"]);
  }, 20000);
});
