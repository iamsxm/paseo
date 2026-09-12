// 日期：2026-09-12；执行者：Codex。版本比较和写入共享事务，离线旧配置不能覆盖删除墓碑。
routerAdd(
  "POST",
  "/api/paseo/hosts/sync",
  (e) => {
    const body = e.requestInfo().body;
    if (!Array.isArray(body.changes) || body.changes.length > 500) {
      throw new BadRequestError("Expected at most 500 host changes");
    }
    function cleanProfile(profile) {
      if (profile === null) return null;
      if (
        !profile ||
        typeof profile.label !== "string" ||
        profile.label.length > 200 ||
        !profile.label.trim()
      ) {
        throw new BadRequestError("Invalid host label");
      }
      if (
        !Array.isArray(profile.connections) ||
        profile.connections.length < 1 ||
        profile.connections.length > 10
      ) {
        throw new BadRequestError("Expected relay connections");
      }
      const connections = profile.connections.map((connection) => {
        if (
          !connection ||
          typeof connection.relayEndpoint !== "string" ||
          !connection.relayEndpoint.trim() ||
          connection.relayEndpoint.length > 512 ||
          typeof connection.useTls !== "boolean" ||
          typeof connection.daemonPublicKeyB64 !== "string" ||
          !/^[A-Za-z0-9+/]{43}=$/.test(connection.daemonPublicKeyB64)
        ) {
          throw new BadRequestError("Invalid relay connection");
        }
        return {
          relayEndpoint: connection.relayEndpoint,
          useTls: connection.useTls,
          daemonPublicKeyB64: connection.daemonPublicKeyB64,
        };
      });
      return { label: profile.label, connections };
    }
    const seen = new Set();
    const changes = body.changes.map((change) => {
      if (
        !change ||
        typeof change.serverId !== "string" ||
        !change.serverId.trim() ||
        change.serverId.length > 256 ||
        !Number.isSafeInteger(change.baseRevision) ||
        change.baseRevision < 0 ||
        seen.has(change.serverId)
      ) {
        throw new BadRequestError("Invalid or duplicate host change");
      }
      seen.add(change.serverId);
      return {
        serverId: change.serverId,
        baseRevision: change.baseRevision,
        profile: cleanProfile(change.profile),
      };
    });
    const conflicts = [];
    let records = [];
    e.app.runInTransaction((app) => {
      const collection = app.findCollectionByNameOrId("synced_hosts");
      const rows = app.findRecordsByFilter("synced_hosts", "owner = {:owner}", "", 0, 0, {
        owner: e.auth.id,
      });
      const byServer = new Map(rows.map((row) => [row.getString("serverId"), row]));
      for (const change of changes) {
        let row = byServer.get(change.serverId);
        const revision = row ? row.getInt("revision") : 0;
        // 重试已提交的请求时返回同一结果，不再递增版本。
        const previous = row ? cleanProfile(JSON.parse(row.getString("profile") || "null")) : null;
        if (row && JSON.stringify(previous) === JSON.stringify(change.profile)) continue;
        if (revision !== change.baseRevision) {
          conflicts.push(change.serverId);
          continue;
        }
        if (!row) {
          row = new Record(collection);
          row.set("owner", e.auth.id);
          row.set("serverId", change.serverId);
          byServer.set(change.serverId, row);
        }
        row.set("revision", revision + 1);
        row.set("profile", change.profile);
        app.save(row);
      }
      records = Array.from(byServer.values()).map((row) => ({
        serverId: row.getString("serverId"),
        revision: row.getInt("revision"),
        profile: row.get("profile"),
      }));
    });
    return e.json(200, { records, conflicts });
  },
  $apis.requireAuth("sync_users"),
);
