FROM --platform=$BUILDPLATFORM harbor-core.harbor.svc/library/node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm config set allow-builds esbuild,vue-demi && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM harbor-core.harbor.svc/library/nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]