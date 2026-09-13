# AGENTS.md — Paseo 项目协作说明

更新日期：2026-09-12；维护者：Codex。

## 开始工作

本仓库是 Paseo 的 npm workspaces monorepo。先阅读根目录 `CLAUDE.md`，列出 `docs/`，再阅读本次修改涉及的主题文档。子目录如果有 `AGENTS.md` 或 `CLAUDE.md`，同时遵循其适用约定。用户当前明确指令优先于仓库的一般工作约定。

若存在本机 `PLAN.md`，先读取它以恢复当前进度、已获授权、阻塞和未完成事项。不要把运行中的构建当作成功，也不要仅根据旧报告判断线上状态。复杂任务开始时更新计划，完成后记录实际验证结果。

## 仓库结构

| 路径                                   | 职责                                     |
| -------------------------------------- | ---------------------------------------- |
| `packages/app`                         | Expo / React Native 客户端，包含 Web     |
| `packages/server`                      | daemon、agent 生命周期、WebSocket 与 MCP |
| `packages/client`、`packages/protocol` | 客户端 SDK 与协议                        |
| `packages/relay`                       | 加密 relay 传输                          |
| `packages/desktop`                     | 桌面包装与平台集成                       |
| `packages/cli`                         | 命令行入口                               |
| `packages/app/src/host-sync`           | 账号、配置同步、离线队列与设置 UI        |
| `docker/host-sync`                     | PocketBase、Web 镜像及 Compose 配置      |
| `docs/host-sync.md`                    | 同步部署、使用、冲突与退出语义           |

## VPS 连接同步的边界

同步对象为 relay 配对连接所需信息、serverId、主机名称和增删状态。模型配置、MCP、聊天历史、SSH 私钥、直连密码及设备偏好不属于同步内容。

复用 PocketBase 官方账号与数据库能力；复用 `HostRuntimeStore` 的主机管理和自动连接。不要另建 daemon 会话管理或自研身份系统。只有实际需求需要时才扩展现有接口。

- 客户端持久化位于 `@paseo:host-sync:v1`；账号数据按后台地址和用户隔离。
- `POST /api/paseo/hosts/sync` 使用 revision 做并发比较，版本检查与写入必须处于同一事务。
- 删除墓碑不能随意清理，避免离线设备重新带回已删除主机。
- 相同快照应保留主机对象引用，避免轮询反复写入和更新连接。
- 远程变更只替换 relay 连接，保留设备专属连接与偏好。

更改同步语义时，同时检查模型测试、真实 PocketBase 集成测试和部署文档。

## 实现约定

优先沿用现有依赖、构建脚本、组件、测试框架及命名。阅读至少一个相似实现后再修改，避免无关重构。新增注释使用中文，解释意图与约束。

React 表单遵循 `docs/forms.md`，使用既有表单模型、`Field` 与 `FormTextInput`。路由或启动恢复变更前阅读 `docs/expo-router.md`；样式遵循 `docs/design.md` 与 `docs/unistyles.md`。增加翻译后检查所有语言资源的一致性。

协议修改遵循 `docs/protocol-compatibility.md`。跨 workspace 类型出错时，先构建拥有声明的依赖包，不能为绕过陈旧声明而修改业务类型。

## 验证

只运行与本次改动有关的测试，禁止在本机运行整个仓库测试套件。格式化和 lint 使用现有 npm 脚本。区分未执行、失败、修复后通过，不能把静态检查描述成实际部署测试。

```bash
npm run format:files -- <changed-files>
npm run lint -- <changed-source-files>
npm run typecheck --workspace=@getpaseo/app
```

同步功能的针对性验证：

```bash
PASEO_HOST_SYNC_TEST_BINARY=/path/to/pocketbase npx vitest run \
  packages/app/src/host-sync/model.test.ts \
  packages/app/src/host-sync/sign-in-form.test.ts \
  docker/host-sync/host-sync.test.ts \
  packages/app/src/i18n/resources.test.ts --maxWorkers=1 --bail=1
npm run build:web --workspace=@getpaseo/app
```

PowerShell 中通过 `$env:PASEO_HOST_SYNC_TEST_BINARY` 设置二进制路径。集成测试必须使用真实 PocketBase 临时实例，不能使用用户的生产数据库。普通 Web 构建由 `packages/app/dist` 输出。

GitHub Actions 仅在任务需要且已有用户授权时运行；当前镜像工作流位于 `.github/workflows/host-sync-images.yml`。不要为了单个功能触发无关发布流程。

## Git、凭据与记录

- 开始修改和提交前检查 `git status`，保留用户未提交的工作。新分支默认使用 `codex/` 前缀。
- 暂存明确的文件清单；提交前检查 diff 和敏感信息。工具扫描通过后仍要核对文件名与范围。
- 不提交密码、token、SSH 私钥、真实用户配对资料、数据库、备份或本机凭据。
- `.codex/` 与 `PLAN.md` 存放本地进度、验证报告及必要的私人部署信息，已被 Git 忽略；不得强制添加。
- 镜像构建不能包含凭据目录。GHCR 使用 Actions 临时 `GITHUB_TOKEN`，不得将本机 token 写入 Dockerfile 或上传 VPS。
- Git push、外部部署以用户授权范围为准；已有明确授权不重复询问。未经授权不推送到上游。
- 工作日志和审查报告保留在项目本地 `.codex/`，记录日期、执行者、命令结果和遗留事项，避免重复复制秘密内容。

## 部署与恢复

先读取 `docs/host-sync.md` 和本机计划，核对 SSH 目标、现有端口、站点配置与部署版本。使用独立 Compose 项目，保留数据库 volume，按完整提交 SHA 部署，记录上一版本以便回滚。

禁止在未获明确许可时重启主 Paseo daemon，尤其是 6767 端口实例。禁止因请求超时推断服务应重启。不要修改无关服务，不要执行会删除生产数据的 `docker compose down -v`。

反向代理修改必须先检查配置再平滑重载。镜像构建成功、容器健康、源站 HTTPS、公开域名、账号登录和实际同步分别验证，不能用其中一项替代其余项。最终交付说明完成项、验证证据和实际未完成事项。
