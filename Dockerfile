# ---- Base image ----
FROM node:20-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# ---- Dependencies ----
# Install production dependencies first to leverage Docker layer caching.
FROM base AS deps
COPY package*.json ./
RUN npm install --omit=dev

# ---- Runtime ----
FROM base AS runtime
# Run as the unprivileged user shipped with the node image.
COPY --from=deps /app/node_modules ./node_modules
COPY . .

EXPOSE 4000
USER node
CMD ["node", "src/index.js"]
