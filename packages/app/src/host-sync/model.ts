import { z } from "zod";
import equal from "fast-deep-equal";
import type { HostProfile, RelayHostConnection } from "@/types/host-connection";
import { defaultLifecycle } from "@/types/host-connection";
import { defaultHostAppearance } from "@/hosts/appearance";

const RelaySchema = z.object({
  relayEndpoint: z.string().trim().min(1).max(512),
  useTls: z.boolean(),
  daemonPublicKeyB64: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
});
export const SyncedProfileSchema = z.object({
  label: z.string().trim().min(1).max(200),
  connections: z.array(RelaySchema).min(1).max(10),
});
export type SyncedProfile = z.infer<typeof SyncedProfileSchema>;
export const HostRecordSchema = z.object({
  serverId: z.string().min(1).max(256),
  revision: z.number().int().positive(),
  profile: SyncedProfileSchema.nullable(),
});
export type HostRecord = z.infer<typeof HostRecordSchema>;
export const HostChangeSchema = z.object({
  serverId: z.string().min(1).max(256),
  baseRevision: z.number().int().nonnegative(),
  profile: SyncedProfileSchema.nullable(),
});
export type HostChange = z.infer<typeof HostChangeSchema>;
export const SyncResponseSchema = z.object({
  records: z.array(HostRecordSchema),
  conflicts: z.array(z.string()),
});
export type SyncResponse = z.infer<typeof SyncResponseSchema>;
export const CheckpointSchema = z.object({
  records: z.array(HostRecordSchema),
  pending: z.array(HostChangeSchema),
  initialized: z.boolean(),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export function emptyCheckpoint(): Checkpoint {
  return { records: [], pending: [], initialized: false };
}

export function projectRelayHosts(hosts: HostProfile[]): Map<string, SyncedProfile> {
  const result = new Map<string, SyncedProfile>();
  for (const host of hosts) {
    const connections = host.connections.filter((connection) => connection.type === "relay");
    if (connections.length === 0) continue;
    result.set(host.serverId, {
      label: host.label,
      connections: connections
        .map((connection) => ({
          relayEndpoint: connection.relayEndpoint,
          useTls: connection.useTls ?? connection.relayEndpoint.endsWith(":443"),
          daemonPublicKeyB64: connection.daemonPublicKeyB64,
        }))
        .sort((a, b) => a.relayEndpoint.localeCompare(b.relayEndpoint)),
    });
  }
  return result;
}

export function sameProfile(left: SyncedProfile | null, right: SyncedProfile | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function captureChanges(checkpoint: Checkpoint, hosts: HostProfile[]): HostChange[] {
  const local = projectRelayHosts(hosts);
  const records = new Map(checkpoint.records.map((record) => [record.serverId, record]));
  const pendingIds = new Set(checkpoint.pending.map((change) => change.serverId));
  const ids = new Set([...local.keys(), ...records.keys(), ...pendingIds]);
  const changes: HostChange[] = [];
  for (const serverId of ids) {
    const record = records.get(serverId);
    const profile = local.get(serverId) ?? null;
    const removedDuringCreate = !record && pendingIds.has(serverId) && profile === null;
    if (sameProfile(profile, record?.profile ?? null) && !removedDuringCreate) continue;
    changes.push({ serverId, baseRevision: record?.revision ?? 0, profile });
  }
  return changes;
}

// 远程配置只替换 relay；本机 socket、SSH、直连与外观继续由设备持有。
export function mergeRelayHosts(hosts: HostProfile[], records: HostRecord[]): HostProfile[] {
  const result = new Map(hosts.map((host) => [host.serverId, host]));
  for (const record of records) {
    const merged = mergeRelayHost(result.get(record.serverId), record);
    if (merged) result.set(record.serverId, merged);
    else result.delete(record.serverId);
  }
  const next = [...result.values()];
  return next.length === hosts.length && next.every((host, index) => host === hosts[index])
    ? hosts
    : next;
}

function mergeRelayHost(previous: HostProfile | undefined, record: HostRecord): HostProfile | null {
  const now = new Date().toISOString();
  const base: HostProfile = previous ?? {
    serverId: record.serverId,
    label: record.serverId,
    connections: [],
    preferredConnectionId: null,
    appearance: defaultHostAppearance(),
    lifecycle: defaultLifecycle(),
    createdAt: now,
    updatedAt: now,
  };
  const deviceConnections = base.connections.filter((connection) => connection.type !== "relay");
  const relayConnections: RelayHostConnection[] =
    record.profile?.connections.map((connection) => ({
      ...connection,
      type: "relay",
      id: `relay:${connection.useTls ? "wss:" : ""}${connection.relayEndpoint}`,
    })) ?? [];
  const connections = [...deviceConnections, ...relayConnections];
  if (connections.length === 0) return null;
  const preferredConnectionId =
    connections.find((connection) => connection.id === base.preferredConnectionId)?.id ??
    connections[0].id;
  const label = record.profile?.label ?? base.label;
  if (
    base.label === label &&
    base.preferredConnectionId === preferredConnectionId &&
    equal(base.connections, connections)
  )
    return base;
  return { ...base, label, connections, preferredConnectionId, updatedAt: now };
}

export function overlayPending(checkpoint: Checkpoint): HostRecord[] {
  const records = new Map(checkpoint.records.map((record) => [record.serverId, record]));
  for (const change of checkpoint.pending) {
    records.set(change.serverId, {
      serverId: change.serverId,
      revision: change.baseRevision + 1,
      profile: change.profile,
    });
  }
  return [...records.values()];
}

export function acceptResponse(
  checkpoint: Checkpoint,
  sent: HostChange[],
  response: SyncResponse,
): Checkpoint {
  const sentById = new Map(sent.map((change) => [change.serverId, change]));
  const remote = new Map(response.records.map((record) => [record.serverId, record]));
  const pending: HostChange[] = [];
  for (const change of checkpoint.pending) {
    const sentChange = sentById.get(change.serverId);
    const record = remote.get(change.serverId);
    if (response.conflicts.includes(change.serverId)) continue;
    if (sentChange && sameProfile(change.profile, sentChange.profile)) continue;
    // 请求在途时的本机编辑保留；远端删除优先，防止旧编辑复活主机。
    if (record?.profile === null) continue;
    pending.push({ ...change, baseRevision: record?.revision ?? 0 });
  }
  return { records: response.records, pending, initialized: true };
}
