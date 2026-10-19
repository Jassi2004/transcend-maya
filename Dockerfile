FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm test && npm run build && npm prune --omit=dev
FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4200 DATABASE_PATH=/data/maya.sqlite
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 4200
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/cli.js"]
