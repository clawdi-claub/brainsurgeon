# BrainSurgeon TypeScript API
FROM node:22-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy built code
COPY dist ./dist

# Create data directory
RUN mkdir -p /data

EXPOSE 8000

ENV PORT=8000
ENV SESSIONS_DIR=/data/sessions
ENV DATA_DIR=/data

CMD ["node", "dist/app.js"]
