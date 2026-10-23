# No Repro server, for Fly.io (or any Docker host).
FROM oven/bun:1.4
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

# Projects, checks and Sentry installs live on the mounted volume, so they survive deploys.
ENV NOREPRO_DATA_DIR=/data
ENV PORT=8080
EXPOSE 8080
CMD ["bun", "src/server/index.ts"]
