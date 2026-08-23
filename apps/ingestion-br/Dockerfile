FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

RUN set -ex && apk add --no-cache ffmpeg python3 py3-pip git curl deno \
    && pip3 install --break-system-packages --upgrade --no-cache-dir yt-dlp bgutil-ytdlp-pot-provider \
    && yt-dlp --version && ffmpeg -version | head -1

RUN set -ex && git clone --depth 1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil-pot-provider \
    && cd /opt/bgutil-pot-provider/server \
    && npm install --include=dev \
    && ./node_modules/.bin/tsc \
    && test -f build/main.js

COPY package.json ./
RUN npm install @supabase/supabase-js@^2.49.1 --save

COPY server.js ./

EXPOSE 8090 4416
CMD ["node", "server.js"]
