FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY index.html ./
COPY admin.html ./
COPY assets ./assets
COPY data/.gitkeep ./data/.gitkeep

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]
