# services/fg-roster/Dockerfile — built from the app repo root:
#   docker build -f services/fg-roster/Dockerfile -t <img> .
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY services ./services
ENV PORT=8080
EXPOSE 8080
CMD ["node", "services/fg-roster/server.js"]
