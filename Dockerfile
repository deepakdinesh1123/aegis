FROM node:20-slim
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
# Include devDependencies so smee-client is available for WEBHOOK_PROXY_URL.
RUN npm ci
RUN npm cache clean --force
ENV NODE_ENV="production"
ENV HOST="0.0.0.0"
COPY . .
RUN npm run build
CMD [ "npm", "start" ]
