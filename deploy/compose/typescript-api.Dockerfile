FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci

COPY apps/api apps/api
COPY apps/web apps/web
RUN npm run build

FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    WEB_DIST_DIR=/app/web

COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps/api/dist /app/api/dist
COPY --from=build /app/apps/web/dist /app/web

USER node
EXPOSE 8080
CMD ["node", "/app/api/dist/index.js"]
