FROM node:20-bookworm-slim

# Python for generated MCP servers (Wave 9)
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Playwright + Chromium for browser-worker (Wave 11 / computer-use)
RUN npx -y playwright install --with-deps chromium

WORKDIR /app
COPY . .

VOLUME /data
ENV STATE_DIR=/data PORT=8795
EXPOSE 8795
CMD ["node", "prototype/hub/hub.mjs"]
