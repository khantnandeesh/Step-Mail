FROM node:20-alpine

WORKDIR /app

# Docker CLI for admin redeploy (docker.sock mounted at runtime)
RUN apk add --no-cache docker-cli docker-cli-compose curl bash

COPY package*.json ./


RUN npm install --omit=dev


COPY . .

# Expose ports (API and SMTP)
EXPOSE 3001
EXPOSE 25

# Start the server
CMD ["node", "index.js"]
