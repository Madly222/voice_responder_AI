FROM node:20-alpine
# docker-cli is needed to restart containers through the mounted docker.sock
RUN apk add --no-cache docker-cli docker-cli-compose
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 8090
CMD ["node", "server.js"]
