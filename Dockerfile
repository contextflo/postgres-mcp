# Two stages so the published image carries no TypeScript toolchain or dev dependencies.
#
# The build stage always runs on the build machine's own platform. Every runtime dependency
# is plain JavaScript or WebAssembly, so node_modules is the same on amd64 and arm64 and is
# copied into each image rather than installed under QEMU emulation, which is slow enough
# to hang a multi-arch build.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev


FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Never run as root: this process only needs to open a socket and read two files.
USER node

# stdio by default (`docker run -i ... <connection-string>`). For a remote endpoint add
# `--http --host 0.0.0.0` and publish the port. See the Docker section of the README,
# including why you want AUTH_TOKEN and a private network before you do that.
EXPOSE 8080

ENTRYPOINT ["node", "dist/index.js"]
