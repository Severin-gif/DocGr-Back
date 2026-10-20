FROM node:24-bookworm-slim AS base
WORKDIR /app
# Timeweb builds have a 1680s limit. Avoid the slow plain-HTTP package path
# and retry stalled transfers before the whole build is killed.
# Slim images can lack system CAs: bootstrap verified HTTPS with Node's
# bundled Mozilla roots, then use the installed Debian CA store normally.
RUN node -e "require('node:fs').writeFileSync('/tmp/docgrid-apt-ca.pem', require('node:tls').rootCertificates.join('\n'))" \
    && sed -i 's|http://deb.debian.org/|https://deb.debian.org/|g' /etc/apt/sources.list.d/debian.sources \
    && printf '%s\n' 'Acquire::Retries "3";' 'Acquire::http::Timeout "30";' 'Acquire::https::Timeout "30";' > /etc/apt/apt.conf.d/80docgrid-network \
    && apt-get -o Acquire::https::CAInfo=/tmp/docgrid-apt-ca.pem -o APT::Update::Error-Mode=any update \
    && apt-get -o Acquire::https::CAInfo=/tmp/docgrid-apt-ca.pem install -y --no-install-recommends openssl ca-certificates \
    && rm -f /tmp/docgrid-apt-ca.pem \
    && rm -rf /var/lib/apt/lists/*

FROM base AS build
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund
COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM base AS production
ENV NODE_ENV=production PORT=4000
RUN apt-get -o APT::Update::Error-Mode=any update && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-rus tesseract-ocr-eng python3 python3-venv ghostscript python3-xlrd python3-openpyxl python3-lxml antiword util-linux libreoffice-writer fonts-dejavu-core postgresql-client && rm -rf /var/lib/apt/lists/*
COPY scripts/document-tools-requirements.txt /tmp/document-tools-requirements.txt
RUN python3 -m venv /opt/docgrid-tools && /opt/docgrid-tools/bin/pip install --no-cache-dir -r /tmp/document-tools-requirements.txt
ENV DOCGRID_TOOLS_PYTHON=/opt/docgrid-tools/bin/python
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev --no-audit --no-fund && npx prisma generate --schema prisma/live/schema.prisma && npm cache clean --force
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node scripts ./scripts
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "if [ -n \"$DATABASE_URL\" ]; then node scripts/migrate.cjs || exit 1; fi; exec node dist/server.js"]


