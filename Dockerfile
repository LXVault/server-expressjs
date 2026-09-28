# ---- Base image ----
# node:20 reached end of life in April 2026, so the previous tag here no
# longer receives security fixes. node:22 is the line this was verified on.
FROM node:22-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# ---- Dependencies ----
# Install production dependencies first to leverage Docker layer caching.
# `npm ci` installs exactly what package-lock.json pins and fails if the two
# disagree. `npm install` was resolving ranges at build time, so the image
# could contain a different tree than the one that was audited.
FROM base AS deps
COPY package*.json ./
RUN npm ci --omit=dev

# ---- Runtime ----
FROM base AS runtime
# Run as the unprivileged user shipped with the node image.
COPY --from=deps /app/node_modules ./node_modules
COPY . .

EXPOSE 4000
USER node
CMD ["node", "src/index.js"]
