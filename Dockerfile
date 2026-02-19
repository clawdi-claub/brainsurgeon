# BrainSurgeon TypeScript API
# Multi-stage build

# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /build

# Copy package files
COPY ts-api/package*.json ./
RUN npm ci

# Copy source and build
COPY ts-api/src ./src
COPY ts-api/tsconfig.json ./
RUN npm run build

# Stage 2: Production
FROM node:22-alpine

WORKDIR /app

# Install production dependencies
COPY ts-api/package*.json ./
RUN npm ci --only=production

# Copy built code
COPY --from=builder /build/dist ./dist

# Create data directory
RUN mkdir -p /data

EXPOSE 8000

ENV PORT=8000
ENV AGENTS_DIR=/data/openclaw/agents
ENV DATA_DIR=/data

CMD ["node", "dist/app.js"]
