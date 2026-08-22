FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY apps/api apps/api
COPY apps/web apps/web
COPY apps/worker apps/worker
RUN npm run build --workspace apps/api && npm run build --workspace apps/web && npm run build --workspace apps/worker

ARG BUILD_VERSION=20260822-1
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# Runtime deps incl. git (bgutil clone), toolchain p/ canvas nativo + plugin PO Token
RUN set -ex && apk add --no-cache ffmpeg python3 py3-pip py3-opencv deno fontconfig ttf-dejavu git curl build-base pixman-dev cairo-dev pango-dev libjpeg-turbo-dev giflib-dev \
    && pip3 install --break-system-packages --upgrade --no-cache-dir yt-dlp bgutil-ytdlp-pot-provider \
    && which ffmpeg && which yt-dlp && ffmpeg -version && yt-dlp --version

# bgutil PO Token Provider HTTP server (Node implementation, serves :4416)
RUN set -ex && git clone --depth 1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil-pot-provider \
    && cd /opt/bgutil-pot-provider/server \
    && npm install --include=dev \
    && ./node_modules/.bin/tsc \
    && test -f build/main.js

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/worker/package.json apps/worker/package.json
COPY --from=build /app/apps/worker/dist apps/worker/dist
COPY --from=build /app/apps/worker/scripts apps/worker/scripts
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/apps/web/server.mjs apps/web/server.mjs
COPY railway-entrypoint.sh ./railway-entrypoint.sh
RUN chmod +x ./railway-entrypoint.sh
EXPOSE 4000
CMD ["./railway-entrypoint.sh"]
