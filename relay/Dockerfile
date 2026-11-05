FROM node:22-alpine

WORKDIR /opt/any-listen-relay

# 零依赖：只需要源码本身。
COPY package.json relay.mjs ./
COPY lib ./lib

ENV HOST=0.0.0.0 \
    PORT=8099 \
    LOG_LEVEL=info

EXPOSE 8099

USER node

CMD ["node", "relay.mjs"]
