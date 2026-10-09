# The verify harness builds this image with an `sdk` build context: verify/svelte-vendor,
# which holds local @seamless-auth/client and @seamless-auth/svelte tarballs on a --local
# run and nothing otherwise. Without them, the published @seamless-auth/svelte is used.
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY --from=sdk . /tmp/sdk/
ARG SEAMLESS_SVELTE_VERSION=latest
RUN if ls /tmp/sdk/*.tgz >/dev/null 2>&1; then \
      npm install --no-save /tmp/sdk/*.tgz; \
    else \
      npm install --no-save "@seamless-auth/svelte@${SEAMLESS_SVELTE_VERSION}"; \
    fi
COPY . .

FROM deps AS dev
EXPOSE 5173
CMD ["npm", "run", "dev"]

FROM deps AS builder
RUN npm run build

FROM nginx:alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/build /usr/share/nginx/html
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 80
CMD ["/entrypoint.sh"]
