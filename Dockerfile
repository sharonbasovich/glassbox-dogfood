# Runtime has zero npm dependencies: Node 24 runs the TypeScript sources directly
# (type stripping) and uses the built-in node:sqlite. No network needed at runtime.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 GLASSBOX_DB=/data/glassbox.db
COPY package.json ./
COPY src ./src
COPY public ./public
COPY data/fixtures.json ./data/fixtures.json
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
