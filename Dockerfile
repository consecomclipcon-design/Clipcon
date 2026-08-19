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

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/worker/package.json apps/worker/package.json
COPY --from=build /app/apps/worker/dist apps/worker/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY railway-entrypoint.sh ./railway-entrypoint.sh
RUN chmod +x ./railway-entrypoint.sh
EXPOSE 4000
CMD ["./railway-entrypoint.sh"]
