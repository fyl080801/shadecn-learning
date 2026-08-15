# 构建产物（`pnpm build` 生成，勿手改）

一个完整可运行的 app 目录：后端、前端静态资源、数据库迁移、镜像构建文件都在这儿，
不依赖仓库里的任何源码。

```
package.json        运行时依赖（版本已锁死）+ start / migrate 脚本
server/index.js     后端入口（ESM，node >= 22），Prisma client 已内联
public/             前端静态资源，后端直接吐这个目录
prisma/             schema + migrations，给 `prisma migrate deploy` 用
prisma.config.js    prisma CLI 配置
Dockerfile          构建上下文就是本目录
```

**这份产物绑定一种数据库**（SQLite 或 PostgreSQL）：内联进来的 Prisma client 在构建时就
把对应的查询编译器编进去了，`prisma/` 里也只有那一种的 schema 和迁移。换库要回仓库里
用 `DB_PROVIDER=…` 重新构建，不是改这里的环境变量。看 `package.json` 的 dependencies
就知道是哪种：`@prisma/adapter-better-sqlite3` = SQLite，`@prisma/adapter-pg` = PostgreSQL。

## 直接跑

```bash
npm install --omit=dev   # SQLite 产物会现场编译 better-sqlite3
npm run migrate          # prisma migrate deploy，SQLite 库不存在会自动建
npm start                # 默认 http://0.0.0.0:3000
```

配置全部走环境变量（`APP_ORIGIN` / `KEYCLOAK_*` / `SESSION_SECRET` / `DATA_DIR` …），
也可以在本目录放一个 `.env`。**「应用根目录」是进程 cwd**，所以相对路径的
`DATA_DIR`、`DATABASE_URL` 都相对启动时所在的目录，请在本目录里启动。
PostgreSQL 产物只需要一个 `DATABASE_URL`（`postgresql://…`），`DATA_DIR` 用不上。

## 打镜像

```bash
docker build -t shadecn-learning .
docker run -p 3000:3000 -v app-data:/app/data \
  -e APP_ORIGIN=https://example.com \
  -e KEYCLOAK_ISSUER=... -e KEYCLOAK_CLIENT_ID=... -e SESSION_SECRET=... \
  shadecn-learning
```
