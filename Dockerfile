# Two stages so the published image carries no TypeScript toolchain or dev dependencies.
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Never run as root: this process only needs to open a socket and read two files.
USER node

# stdio by default (`docker run -i ... <connection-string>`). For a remote endpoint add
# `--http --host 0.0.0.0` and publish the port — see the deployment section of the README,
# including why you want AUTH_TOKEN and a private network before you do that.
EXPOSE 8080

ENTRYPOINT ["node", "dist/index.js"]
