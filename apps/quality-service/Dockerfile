# Quality service — build from monorepo root (needs @praxis/contracts).
# docker compose: context "." dockerfile "apps/quality-service/Dockerfile"
FROM node:22-bookworm-slim
WORKDIR /workspace

COPY package.json package-lock.json ./
COPY packages/contracts ./packages/contracts
COPY packages/knowledge ./packages/knowledge
COPY apps/quality-service ./apps/quality-service

RUN npm install -w @praxis/contracts -w @praxis/knowledge -w @praxis/quality-service \
  && npm run build -w @praxis/contracts \
  && npm run build -w @praxis/knowledge \
  && npm run build -w @praxis/quality-service

WORKDIR /workspace/apps/quality-service
ENV PRAXIS_QUALITY_DB=/data/quality.sqlite
ENV PORT=8787
EXPOSE 8787
VOLUME ["/data"]

CMD ["node", "dist/main.js"]
