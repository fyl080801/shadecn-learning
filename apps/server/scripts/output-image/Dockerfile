# 这个 Dockerfile 由 `pnpm build` 拷进 output/，构建上下文就是 output/ 本身：
#
#   pnpm build && docker build -t shadecn-learning ./output
#
# 镜像里不需要源码、不需要 tsx、也不需要 prisma generate ——
# 后端已经打包成 server/index.js，Prisma client 也内联进去了，
# 这里只装 output/package.json 里那几个运行时依赖。
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
# better-sqlite3 在 musl 上没有预编译包，得现场编译
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

ARG NODE_IMAGE
FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data
COPY --from=deps /app/node_modules ./node_modules
# 打包产物本身：server/（后端）、public/（前端静态资源）、prisma/（schema）
COPY . .
# 构建期自检：node_modules 里的原生模块必须和这一层的 node 同架构 —— 架构串了的话
# 容器照样能起、/api/health 也一路 200，直到第一次查库才炸
# 「Error relocating ...: unsupported relocation type 1026」。宁可构建期就失败。
# 逐个 dlopen 而不是 require 某个包名：postgresql 构建里没有 better-sqlite3。
RUN set -e; \
    found=0; \
    for f in $(find /app/node_modules -name '*.node'); do \
      node -e "process.dlopen({ exports: {} }, process.argv[1])" "$f"; \
      echo "  ok $f"; \
      found=$((found + 1)); \
    done; \
    echo "native modules ok: $found on $(uname -m)"
# SQLite 落在 /app/data，挂卷进来才不会随容器一起没
RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 3000
# 起服务前先把表结构对齐到 schema（db push，没有迁移历史），库文件不存在会自动建。
# 不带 --accept-data-loss：真要删列删表时宁可启动失败，也不在生产库上静默丢数据
CMD ["sh", "-c", "npx prisma db push && node server/index.js"]
