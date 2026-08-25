FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json ./
COPY tsconfig.json ./
COPY src ./src
COPY bin ./bin

RUN npm install && npm run build

ENV PRAXIS_QUALITY_DB=/data/quality.sqlite
ENV PORT=8787
EXPOSE 8787
VOLUME ["/data"]

CMD ["node", "dist/main.js"]
