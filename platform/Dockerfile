FROM node:22-slim
ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    HOST=0.0.0.0 PORT=3000 \
    DB_FILE=/data/platform.db BACKUP_DIR=/backups \
    SEED_DEMO=0
WORKDIR /app
COPY package.json server.js store.js auth.js logic.js llm.js mailer.js csv.js backup.js migrate-json.js ./
COPY public ./public
RUN mkdir -p /data /backups && chown node:node /data /backups
USER node
VOLUME ["/data", "/backups"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.js"]
