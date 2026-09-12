// 日期：2026-09-12；执行者：Codex。账号由自建后台管理员创建。
migrate(
  (app) => {
    const users = new Collection({
      name: "sync_users",
      type: "auth",
      listRule: "id = @request.auth.id",
      viewRule: "id = @request.auth.id",
      passwordAuth: { enabled: true, identityFields: ["email"] },
    });
    app.save(users);
    app.save(
      new Collection({
        name: "synced_hosts",
        type: "base",
        listRule: "owner = @request.auth.id",
        viewRule: "owner = @request.auth.id",
        fields: [
          {
            name: "owner",
            type: "relation",
            collectionId: users.id,
            required: true,
            maxSelect: 1,
            cascadeDelete: true,
          },
          { name: "serverId", type: "text", required: true, max: 256 },
          { name: "revision", type: "number", required: true, min: 1, onlyInt: true },
          { name: "profile", type: "json", maxSize: 65536 },
        ],
        indexes: [
          "CREATE UNIQUE INDEX idx_synced_hosts_owner_server ON synced_hosts (owner, serverId)",
        ],
      }),
    );
  },
  (app) => {
    app.delete(app.findCollectionByNameOrId("synced_hosts"));
    app.delete(app.findCollectionByNameOrId("sync_users"));
  },
);
