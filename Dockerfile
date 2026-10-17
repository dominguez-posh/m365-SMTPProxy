# Management server image: web app (dist/), server bundle and the client package (client-package/, built by
# tools/build-client.ps1 on Windows before the image build).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY build.mjs tsconfig.json ./
COPY web web
COPY shared shared
COPY server server
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production \
    SMTPPROXY_PORT=8080 \
    SMTPPROXY_DATA=/data \
    SMTPPROXY_STATIC=/app/dist \
    SMTPPROXY_PACKAGE=/app/client-package
WORKDIR /app
COPY --from=build /app/dist dist
COPY --from=build /app/server/dist server/dist
COPY client-package client-package
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "server/dist/server.mjs"]
