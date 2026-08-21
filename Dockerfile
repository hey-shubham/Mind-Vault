FROM node:22-slim AS build
WORKDIR /app
COPY server/package*.json ./server/
RUN npm ci --prefix server
COPY server ./server
RUN npm --prefix server run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/server/package*.json ./server/
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/src ./server/src
RUN mkdir -p /app/server/data/files /app/server/uploads
EXPOSE 4000
CMD ["node","server/dist/index.js"]
