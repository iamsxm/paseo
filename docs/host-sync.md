# VPS 连接同步

日期：2026-09-12；执行者：Codex。

在三台电脑使用同一个自建同步后台账号，即可共享 Paseo 的 VPS relay 连接与主机名称。首次登录会导入本机已有 relay 主机；其他电脑登录后自动获得主机并通过原有连接运行时连接 daemon。

此功能不需要修改 relay。账号、数据库和管理界面使用 PocketBase，部署目录为 `docker/host-sync`。后台只保存连接目录，不运行 agent，也不存储聊天、模型配置或 VPS 私钥。

## 部署后台

在安装 Docker Compose 的 VPS 上，从包含本功能的源码目录执行：

```bash
cd docker/host-sync
docker compose up -d --build
```

镜像固定 PocketBase 0.40.3，支持 amd64/arm64。数据库保存在 Docker volume `host-sync-data`，容器升级不会删除。宿主机仅监听 `127.0.0.1:8090`。

给后台配置域名，例如 `sync.example.com`。如果 Caddy 运行在同一宿主机，配置：

```caddyfile
sync.example.com {
  reverse_proxy 127.0.0.1:8090
}
```

HTTPS 页面应连接 HTTPS 同步地址。若 Caddy 在另一容器中，请配置共同 Docker 网络，通过 `host-sync:8090` 访问。后台域名和现有 `relay.paseo.sh` 各自独立。

首次创建管理员可以使用 PocketBase 管理员命令。以下交互式输入只在自己的 VPS 终端执行，密码由操作者提供：

```bash
read -r -p 'Admin email: ' SYNC_ADMIN_EMAIL
read -r -s -p 'Admin password: ' SYNC_ADMIN_PASSWORD
printf '\n'
docker compose exec host-sync pocketbase superuser upsert \
  "$SYNC_ADMIN_EMAIL" "$SYNC_ADMIN_PASSWORD" --dir=/pb/pb_data
unset SYNC_ADMIN_PASSWORD
```

打开 `https://sync.example.com/_/`，用管理员账号进入 PocketBase 管理界面，在 `sync_users` collection 中创建普通账号，设置邮箱和密码。三台电脑均使用这个普通账号登录。管理员账号用于管理后台，不能直接作为 Paseo 同步账号。

迁移会自动创建 `sync_users` 与 `synced_hosts`。不要手工删除 `synced_hosts` 中 profile 为空的记录，它们是防止离线设备复活已删除主机的删除墓碑。正常修改请通过 Paseo 界面进行。

在后台的 Settings / Backups 定期备份数据库，备份也包含私有主机目录。修改后台版本前保留备份；自定义迁移及 hooks 随源码部署。

## GitHub Actions 镜像部署

`Host Sync Images` 工作流在 `codex/host-sync` 分支推送相关修改或手动触发时，构建 amd64 的 `paseo-host-sync` 与 `paseo-web` 镜像，发布到 fork 所属账号的 GHCR。版本标签包含完整提交 SHA，同时保留 `latest`。

每次构建也保留 14 天的 Docker 镜像压缩包。在已登录 GitHub CLI 的电脑下载，不必把 GitHub token 放在 VPS：

```bash
gh run download RUN_ID --repo YOUR_ACCOUNT/paseo --dir images
scp images/paseo-host-sync-linux-amd64/image.tar.gz HOST:/opt/paseo-host-sync/backend.tar.gz
scp images/paseo-web-linux-amd64/image.tar.gz HOST:/opt/paseo-host-sync/web.tar.gz
```

将 `docker/host-sync/compose.images.yaml` 复制到 VPS 的 `/opt/paseo-host-sync/compose.yaml`，在该目录执行：

```bash
docker load -i backend.tar.gz
docker load -i web.tar.gz
IMAGE_OWNER=YOUR_ACCOUNT IMAGE_TAG=sha-FULL_COMMIT_SHA docker compose up -d --pull never --wait
```

请将 `IMAGE_OWNER` 和 `IMAGE_TAG` 写入 VPS 该目录的 `.env`，便于后续管理。默认后台监听 `127.0.0.1:18090`，Web 监听 `127.0.0.1:18080`。域名反向代理到 Web 端口；Web 内部将 `/api/` 与 `/_/` 转发到 PocketBase，其余路径提供修改版客户端。登录时后台地址与网页域名相同。

管理员创建命令与上文相同。数据库存在命名 volume 中，替换镜像会保留数据。回滚时将 `.env` 的 `IMAGE_TAG` 改为已加载的上一版本再运行 Compose；不要使用 `down -v`。

GitHub Actions 仅使用运行时提供的 `GITHUB_TOKEN` 推送镜像。不要提交 `.env`、PocketBase 数据目录、SSH 私钥或本机 `.codex`；它们也已排除在构建上下文之外。

## 使用客户端

必须使用包含此修改的 Paseo 客户端。官方 `app.paseo.sh` 不会因为部署后台自动出现同步入口。

1. 构建并运行本分支 Web 或桌面客户端。
2. 打开“设置 → 通用 → VPS 连接同步”。尚未添加主机时，也可从欢迎页进入设置。
3. 输入 `https://sync.example.com`、普通账号邮箱和密码，点击“登录并同步”。
4. 在第二、第三台电脑登录同一账号。已有配对信息会自动下载，无需再次逐台粘贴。
5. 此后在任一设备新增 relay 主机、改名或删除，会同步到其他已登录设备。

Web 构建沿用现有命令：

```bash
npm ci
npm run build:web --workspace=@getpaseo/app
```

将 `packages/app/dist` 部署为支持单页应用回退的静态站点。Caddy 示例（替换域名与实际目录）：

```caddyfile
paseo.example.com {
  root * /srv/paseo-web
  try_files {path} /index.html
  file_server
}
```

如希望 VPS 生成的配对链接打开自建页面，可将 daemon 的 `PASEO_APP_BASE_URL` 设置为该 Web 地址；这不改变 relay 地址。已有配对链接也能直接粘贴到自建客户端。

## 同步行为

- 自动轮询间隔 10 秒；本机修改后立即触发同步，应用回到前台也会同步。
- 本机保留连接缓存；后台不可用时仍可连接原 VPS，修改会在恢复后重试。
- 请求 15 秒超时，UI 显示离线并自动重试；会话接近到期时刷新，已过期时提示重新登录。
- 账号按后台地址和用户 ID 隔离；退出会移除本机的账号 relay 连接，未上传修改保留到该账号下次登录。
- 同步名称与 relay 端点、TLS、公钥。SSH 别名、localhost、Unix socket、Windows pipe、直连密码、设备外观与首选连接仍由本机持有。
- 一台主机同时有 relay 与设备专属连接时，远程删除仅移除 relay，保留设备专属连接。
- 第一次登录遇到同 serverId 时采用后台记录；后台已有删除墓碑也优先。新增主机需要首次配对或登记，登录不会自动发现所有 VPS。
- 并发修改采用服务端 revision。请求携带 baseRevision；版本冲突时采用后台版本并在 UI 提示，避免旧电脑覆盖新配置。用户可在同步完成后重新修改。
- 删除在后台保留墓碑；用户已看到删除后再次明确添加同一主机，可以创建新版本。
- 每批最多 500 项，超出分批提交；每主机最多 10 个 relay 连接。

## 实现边界

`packages/app/src/host-sync` 持有账号、离线队列和合并逻辑。`HostRuntimeStore.applySyncedRelayHosts()` 把合并后的主机交给现有控制器自动连接，不另建 daemon 会话实现。相同目录快照保持原有对象引用，不因轮询反复写入注册表或更新连接。

`POST /api/paseo/hosts/sync` 使用 PocketBase 普通账号 token，输入为 `{ changes: [{ serverId, baseRevision, profile }] }`；profile 为 `{ label, connections }` 或表示删除的 null。响应包含账号的权威 `records` 和本次 `conflicts`。版本检查及写入使用同一数据库事务，相同内容重试不增加版本。

当前登录方式是自建账号的邮箱与密码。GitHub OAuth 不属于本次实现；如以后添加，可继续复用同一个主机目录。

## Windows 桌面客户端

日期：2026-09-13；执行者：Codex。

Fork 的 `Host Sync Desktop` 工作流复用 `npm run build:desktop` 和打包后冒烟测试，生成 Windows x64 安装程序与 ZIP 包。当前桌面发行版本为 0.8.1；daemon 和协议仍使用当前源码的版本。此版本号用于 fork 的桌面发行，不发布 npm 包。

在 fork 的 Actions 页面手动运行该工作流，成功后下载 `host-sync-desktop-windows-x64` 产物。安装程序用于日常使用，ZIP 解压后可直接启动 `Paseo.exe`。构建未配置 Windows 代码签名证书，因此系统可能显示未知发布者。

打开“设置 → 通用 → VPS 连接同步”，输入自建后台地址与普通账号。三台电脑使用同一账号；首次登录会导入已登记的 relay 主机。同步状态和真实 VPS 连接状态需要分别确认。

`electron-builder` 的发布目标在构建时指向 fork 所属账号，更新使用 `latest` 通道。发布 GitHub Release 时一起上传安装程序、ZIP、blockmap 和 `latest.yml`，保持更新清单与二进制来自同一次构建。不得将更新源改回上游，否则同步功能可能被官方包替换。

本地验收使用独立 `PASEO_ELECTRON_USER_DATA_DIR` 与 `PASEO_HOME`；不要复用用户正在运行的 daemon 或生产数据。三个隔离客户端状态的测试不能表述为三台物理电脑实测。

## 本地验证

下载官方 PocketBase 0.40.3 本机可执行文件后，把其路径放入 `PASEO_HOST_SYNC_TEST_BINARY`，运行指定测试。未设置时测试尝试 PATH 中的 `pocketbase`，不会跳过后台验证。

```bash
PASEO_HOST_SYNC_TEST_BINARY=/path/to/pocketbase npx vitest run \
  packages/app/src/host-sync/model.test.ts \
  packages/app/src/host-sync/sign-in-form.test.ts \
  docker/host-sync/host-sync.test.ts --maxWorkers=1 --bail=1
npm run typecheck --workspace=@getpaseo/app
npm run lint -- packages/app/src/host-sync docker/host-sync/host-sync.test.ts
```

集成测试会自动启动真实 PocketBase，创建临时数据库和测试账号，验证三台设备、并发、重试、删除墓碑与重启登录恢复；结束后关闭实例并删除临时数据。测试中的主机是虚构数据，不连接用户 VPS。

参考：[PocketBase 部署](https://pocketbase.io/docs/going-to-production/)、[JavaScript SDK](https://github.com/pocketbase/js-sdk)、[JS 路由](https://pocketbase.io/docs/js-routing/)。
