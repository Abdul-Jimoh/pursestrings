# Build from the repo root: fly deploy . --config apps/range/fly.toml
FROM node:22.14.0-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/mcp/package.json packages/mcp/
COPY apps/shop/package.json apps/shop/
COPY apps/range/package.json apps/range/
RUN pnpm install --frozen-lockfile --prod --filter @pursestrings/range...
COPY packages/sdk/src packages/sdk/src
COPY packages/mcp/src packages/mcp/src
COPY apps/shop/src apps/shop/src
COPY apps/range/src apps/range/src
ENV NODE_ENV=production RANGE_PORT=8080 RANGE_DATA=/data/attacks.jsonl SHOP_DATA=/data/reports.jsonl BOARD_DATA=/data/reviews.jsonl
EXPOSE 8080
CMD ["node", "--experimental-strip-types", "--no-warnings", "apps/range/src/main.ts"]
