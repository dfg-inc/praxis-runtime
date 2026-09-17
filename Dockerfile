# Praxis monorepo — workspace verify image
FROM node:22-bookworm AS deps
WORKDIR /workspace
COPY package.json package-lock.json* ./
COPY packages ./packages
COPY plugins ./plugins
COPY apps ./apps
COPY tools ./tools
COPY samples ./samples
RUN npm install

FROM deps AS test
WORKDIR /workspace
ARG SOURCE_COMMIT=unknown
ENV PRAXIS_SOURCE_COMMIT=$SOURCE_COMMIT
COPY Makefile README.md docker-compose.yml Dockerfile ./
COPY docs ./docs
COPY claude-plugins ./claude-plugins
# verify runs build → typecheck → test → boundaries (ordered)
CMD ["npm", "run", "verify"]

FROM deps AS runtime
WORKDIR /workspace
CMD ["npm", "run", "verify"]
