# 这个 Dockerfile 由 `pnpm build` 拷进 output/，构建上下文就是 output/ 本身：
#
#   pnpm build && docker build -t shadecn-learning ./output
#
# 镜像里不需要源码、不需要 tsx —— 后端已经打包成 server/index.js（服务）和
# server/db-sync.js（表结构同步），这里只装 output/package.json 里那几个运行时依赖。
# 同一个镜像连 SQLite 还是 PostgreSQL 由运行时的 DB_PROVIDER / DATABASE_URL 决定。
#
# 基础镜像走构建参数，不写死地址（和仓库根 Dockerfile 一致）；
# 在外网环境构建就把它换回官方的 node:22-alpine。
#
# 默认值是 Harbor 上 docker.io 的**代理缓存**。它有一个已知的别扭之处：多架构镜像的
# index 是边拉边填的，缓存还没填全时它会把一份**缺架构的 index** 发给客户端，
# buildah 当场报 `no image found in image index for architecture "amd64"` ——
# 一条流水线里前两个 stage 拉得好好的、第三个 stage 就挂了，就是这么回事。
# 缓存热了之后自己就好了，所以**碰上先重试**（Harbor 侧不用动：core / jobservice /
# registry 都已经配了出网代理，实测直连 docker.io 超时、走代理正常）。
#
# 留成参数是为了在重试也不灵的时候有别的路可走：指到一份不经代理缓存的引用
# （Harbor 里自己存的多架构副本，或按 index digest 固定），而 `docker build ./output`
# 保持开箱即用。
#   docker build --build-arg NODE_IMAGE=<引用> ...
ARG NODE_IMAGE=192.168.68.95:31443/docker.io/library/node:22-alpine

FROM ${NODE_IMAGE} AS deps
# 不需要编译工具链：better-sqlite3（@mikro-orm/sqlite 的依赖）从 13 起把各平台的预编译二进制
# 直接打在包里（含 linuxmusl-x64 / linuxmusl-arm64），并声明了 gypfile: false，npm 不会现场编译
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

ARG NODE_IMAGE
FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data
COPY --from=deps /app/node_modules ./node_modules
# 打包产物本身：server/（后端 + 表结构同步）、public/（前端静态资源）
COPY . .
# 构建期自检：原生模块必须能在这一层的 node 上加载 —— 架构串了的话
# 容器照样能起、/api/health 也一路 200，直到第一次查库才炸
# 「Error relocating ...: unsupported relocation type 1026」。宁可构建期就失败。
# 两步：
# 1. better-sqlite3 按它自己的规则挑二进制（prebuilds/<平台>-<架构>.node）再真开一个库 ——
#    它的 prebuilds/ 里躺着全平台的 .node（darwin / win32 / glibc …），挨个 dlopen 必然失败，
#    所以那个目录不进下面的循环，改由这一句按真实加载路径验；
# 2. 其余原生模块（以后新增的）照旧逐个 dlopen。
RUN set -e; \
    node -e "new (require('better-sqlite3'))(':memory:').prepare('select 1').get(); console.log('  ok better-sqlite3')"; \
    found=1; \
    for f in $(find /app/node_modules -name '*.node' -not -path '*/better-sqlite3/prebuilds/*'); do \
      node -e "process.dlopen({ exports: {} }, process.argv[1])" "$f"; \
      echo "  ok $f"; \
      found=$((found + 1)); \
    done; \
    echo "native modules ok: $found on $(uname -m)"
# SQLite 落在 /app/data，挂卷进来才不会随容器一起没
RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 3000
# 起服务前先把表结构对齐到实体定义（没有迁移历史），库文件 / PG 库不存在会自动建。
# 不带 --force：真要删列删表改类型时宁可启动失败，也不在生产库上静默丢数据。
# exec：让 node 替掉 sh 成为 1 号进程，k8s 的 SIGTERM 才能直接送到它手上（退出前要落库）
CMD ["sh", "-c", "node server/db-sync.js && exec node server/index.js"]
