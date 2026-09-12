import { describe, expect, it } from "vitest";
import {
  acceptResponse,
  captureChanges,
  emptyCheckpoint,
  mergeRelayHosts,
  overlayPending,
  projectRelayHosts,
  type HostRecord,
  type SyncedProfile,
} from "./model";

const profile: SyncedProfile = {
  label: "VPS",
  connections: [
    {
      relayEndpoint: "relay.example.com:443",
      useTls: true,
      daemonPublicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    },
  ],
};
const record: HostRecord = { serverId: "server-a", revision: 1, profile };

describe("VPS host synchronization", () => {
  it("keeps unchanged registry references stable during polling", () => {
    const hosts = mergeRelayHosts([], [record]);
    expect(mergeRelayHosts(hosts, [record])).toBe(hosts);
  });
  it("imports relay hosts and keeps device-only connections and preference", () => {
    const hosts = mergeRelayHosts([], [record]);
    hosts[0].connections.unshift({ type: "directSocket", id: "socket", path: "/tmp/paseo.sock" });
    hosts[0].preferredConnectionId = "socket";
    const merged = mergeRelayHosts(hosts, [
      { ...record, revision: 2, profile: { ...profile, label: "Renamed" } },
    ]);
    expect(merged[0].label).toBe("Renamed");
    expect(merged[0].preferredConnectionId).toBe("socket");
    expect(projectRelayHosts(merged).get(record.serverId)).toEqual({
      ...profile,
      label: "Renamed",
    });
    expect(JSON.stringify([...projectRelayHosts(merged)])).not.toContain("/tmp/paseo.sock");
  });

  it("a remote tombstone removes only relay connections", () => {
    const hosts = mergeRelayHosts([], [record]);
    hosts[0].connections.push({ type: "directTcp", id: "direct", endpoint: "localhost:6767" });
    const merged = mergeRelayHosts(hosts, [{ ...record, revision: 2, profile: null }]);
    expect(merged[0].connections).toEqual([
      { type: "directTcp", id: "direct", endpoint: "localhost:6767" },
    ]);
    expect(merged[0].preferredConnectionId).toBe("direct");
    expect(mergeRelayHosts(mergeRelayHosts([], [record]), [{ ...record, profile: null }])).toEqual(
      [],
    );
  });

  it("does not upload passwords or local-only hosts", () => {
    const hosts = mergeRelayHosts([], [record]);
    hosts[0].connections = [
      { type: "directTcp", id: "direct", endpoint: "localhost:6767", password: "device-only" },
    ];
    expect(captureChanges(emptyCheckpoint(), hosts)).toEqual([]);
  });

  it("keeps a deletion made while initial creation is in flight", () => {
    const sent = { serverId: record.serverId, baseRevision: 0, profile };
    const checkpoint = { records: [], pending: [sent], initialized: true };
    const pending = captureChanges(checkpoint, []);
    expect(pending).toEqual([{ ...sent, profile: null }]);
    const accepted = acceptResponse({ ...checkpoint, pending }, [sent], {
      records: [record],
      conflicts: [],
    });
    expect(accepted.pending).toEqual([{ ...sent, baseRevision: 1, profile: null }]);
    expect(overlayPending(accepted)[0].profile).toBeNull();
  });

  it("preserves edits made while a rename request is in flight", () => {
    const sent = {
      serverId: record.serverId,
      baseRevision: 1,
      profile: { ...profile, label: "First" },
    };
    const pending = { ...sent, profile: { ...profile, label: "Second" } };
    const accepted = acceptResponse(
      { records: [record], pending: [pending], initialized: true },
      [sent],
      {
        records: [{ ...record, revision: 2, profile: sent.profile }],
        conflicts: [],
      },
    );
    expect(accepted.pending).toEqual([{ ...pending, baseRevision: 2 }]);
  });

  it("uses the remote version after a conflict, including deletion", () => {
    const change = {
      serverId: record.serverId,
      baseRevision: 1,
      profile: { ...profile, label: "Offline rename" },
    };
    const tombstone = { ...record, revision: 2, profile: null };
    const accepted = acceptResponse(
      { records: [record], pending: [change], initialized: true },
      [change],
      { records: [tombstone], conflicts: [record.serverId] },
    );
    expect(accepted).toEqual({ records: [tombstone], pending: [], initialized: true });
  });
});
