FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS production
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4000

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build --chown=node:node /app/dist ./dist

USER node
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const http=require('node:http');const r=http.get({host:'127.0.0.1',port:process.env.PORT||4000,path:'/health'},s=>{s.resume();process.exit(s.statusCode===200?0:1)});r.setTimeout(4000,()=>r.destroy());r.on('error',()=>process.exit(1))"

CMD ["node", "dist/server.js"]
