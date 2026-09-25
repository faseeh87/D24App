FROM node:22-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/d24.db
VOLUME /data
EXPOSE 3000
CMD ["npm", "start"]
