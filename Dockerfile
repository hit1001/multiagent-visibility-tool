# agent-visibility dashboard
#   docker build -t agent-visibility .
#   docker run -p 4242:4242 -v mavt-data:/data -e VISIBILITY_PASSWORD=change-me agent-visibility
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Toolchain for better-sqlite3 in case no prebuilt binary matches the platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    VISIBILITY_HOST=0.0.0.0 \
    VISIBILITY_PORT=4242 \
    VISIBILITY_DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json LICENSE ./
COPY src ./src
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4242
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.VISIBILITY_PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# The server refuses to start on 0.0.0.0 without VISIBILITY_PASSWORD.
CMD ["node", "src/server.js"]
