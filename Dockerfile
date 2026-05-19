FROM --platform=$BUILDPLATFORM harbor-core.harbor.svc/library/node:22-alpine AS build
RUN npm install -g pnpm@9.15.9
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN npx vite build

FROM 192.168.68.95:31443/docker.io/library/nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]