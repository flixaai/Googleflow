# =============================================================================
#  Dockerfile — Google Flow Admin Dashboard (Express + Puppeteer-Extra Stealth)
#  Minimal image: Node.js 20 + system Chromium (no Chromium re-download via npm)
#  Target: Railway.app
# =============================================================================
FROM node:20-slim

# --- Install system Chromium + required libs for headless rendering ---------
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    ca-certificates \
    wget \
    gnupg \
    dumb-init \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libxss1 \
    libasound2 \
    libgbm1 \
    --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer where Chromium lives & skip the (heavy) bundled download.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app

# --- Install only the dependencies needed to run server.js ------------------
# (If you keep this repo as the full Next.js template too, `npm ci` will also
#  install the Next.js deps — harmless, just a bigger image. For the smallest
#  possible image, copy only server.js + public/ + a trimmed package.json.)
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./server.js
COPY public ./public

# Session/cookie storage — mount a Railway Volume at this path so logins
# survive redeploys/restarts.
RUN mkdir -p /app/sessions
VOLUME ["/app/sessions"]

ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
