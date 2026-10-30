# 构建产物（`pnpm build` 生成，勿手改）

一个完整可运行的 app 目录：后端、表结构同步入口、前端静态资源、镜像构建文件都在这儿，
不依赖仓库里的任何源码。

```
package.json        运行时依赖（版本已锁死）+ start / db:push 脚本
server/index.js     后端入口（ESM，node >= 22），实体定义和 ORM 配置已内联
server/db-sync.js   表结构同步入口：把库对齐到实体定义（没有迁移文件），有损变更默认拒绝
server/agents/      画布 agent 的定义（*.md，docs/26）：服务端启动时读并校验，坏了就起不来
public/             前端静态资源，后端直接吐这个目录
Dockerfile          构建上下文就是本目录
agent-sandbox/      画布 agent 的 oci 沙箱镜像的构建上下文（runner + 它的 4 个依赖；不进本目录的镜像）
```

**同一份产物 SQLite 和 PostgreSQL 都能连**：连哪种由运行时的 `DB_PROVIDER` / `DATABASE_URL`
决定（不设就是 SQLite），两种驱动（`@mikro-orm/sqlite` 连带 better-sqlite3、
`@mikro-orm/postgresql` 连带 pg）都在依赖里，进程只加载用得上的那一个。

## 直接跑

```bash
npm install --omit=dev   # better-sqlite3 自带各平台预编译二进制，不需要编译工具链
npm run db:push          # node server/db-sync.js：把表结构对齐到实体定义；库不存在会自动建
npm start                # 默认 http://0.0.0.0:3000
```

`db:push` 默认**只放行加东西的变更**（建表、加列、建索引）。真遇到删表、删列、改列类型
（以及 SQLite 上改列引起的整表重建）时，它会把具体语句列出来、拒绝执行、退出码 1，
而不是静默丢数据。确认过那些数据可以不要之后，手动跑一次 `npm run db:push:force`
（`node server/db-sync.js --force`）。`--force` 也会删掉库里实体之外的表。

配置全部走环境变量（`APP_ORIGIN` / `KEYCLOAK_*` / `SESSION_SECRET` / `DATA_DIR` …），
也可以在本目录放一个 `.env`。**「应用根目录」是进程 cwd**，所以相对路径的
`DATA_DIR`、`DATABASE_URL` 都相对启动时所在的目录，请在本目录里启动。
连 PostgreSQL 只需要 `DATABASE_URL`（`postgresql://…`，可带 `?schema=xxx`），`DATA_DIR` 用不上。

## 打镜像

```bash
docker build -t shadecn-learning .
docker run -p 3000:3000 -v app-data:/app/data \
  -e APP_ORIGIN=https://example.com \
  -e KEYCLOAK_ISSUER=... -e KEYCLOAK_CLIENT_ID=... -e SESSION_SECRET=... \
  shadecn-learning
```

容器的启动命令是 `node server/db-sync.js && exec node server/index.js`：结构同步失败（包括被
有损变更守卫拒绝）时服务不会起来。
