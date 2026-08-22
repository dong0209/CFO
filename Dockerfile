# ── 建置階段 ───────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

# 先只複製相依定義，讓相依未變動時可重用快取層
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts vite.server.config.ts vitest.config.ts ./
COPY index.html ./
COPY src ./src
COPY server ./server

# 型別檢查 + 前端 + 伺服器打包（型別檢查失敗即中止建置）
RUN npm run build

# ── 執行階段 ───────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

# 應用程式本身沒有執行期 npm 相依：只需要 Node 與兩個產出目錄
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY package.json ./

# 以非 root 執行；資料目錄需可寫入
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV NODE_ENV=production \
    CFO_HOST=0.0.0.0 \
    CFO_PORT=8080 \
    CFO_DATA_DIR=/data \
    CFO_STATIC_DIR=/app/dist

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CFO_PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist-server/index.mjs"]
