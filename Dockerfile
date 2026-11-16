# Runs the API with Chromium on any server.
#
#   docker build -t api-screenshot .
#   docker run -p 3000:3000 -e API_KEY="$(openssl rand -hex 32)" api-screenshot
#
# Without API_KEY (16 characters or more) every screenshot is refused,
# unless ALLOW_PUBLIC_ACCESS=true.

FROM node:24-slim

# Chromium and fonts, so pages in most scripts and emoji render instead of boxes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium fonts-liberation fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src

# Finished shots are kept here. Mount a volume on it to keep them when the container is replaced.
RUN mkdir -p /var/cache/api-screenshot && chown node:node /var/cache/api-screenshot

# Chromium's own sandbox needs privileges a default container does not give.
# The container is the sandbox here; it runs as an unprivileged user.
ENV NODE_ENV=production \
    CHROME_PATH=/usr/bin/chromium \
    CHROME_NO_SANDBOX=1 \
    CACHE_DIR=/var/cache/api-screenshot \
    PORT=3000
USER node
EXPOSE 3000

# Ties the image to its entry in the MCP registry (registry.modelcontextprotocol.io).
LABEL io.modelcontextprotocol.server.name="io.github.matbrons/api-screenshot"
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/server.ts"]
