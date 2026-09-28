FROM node:24.7.0-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4180 \
    DATA_DIR=/app/persistent/data \
    VIDEO_DIR=/app/persistent/videos

WORKDIR /app
COPY --chown=node:node . .
RUN mkdir -p /app/persistent/data /app/persistent/videos \
    && chown -R node:node /app/persistent

USER node
EXPOSE 4180
CMD ["node", "server.js"]
