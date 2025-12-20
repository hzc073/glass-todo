FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=3000 \
    DB_PATH=/data/database.sqlite \
    API_BASE_URL= \
    USE_LOCAL_STORAGE=false \
    HOLIDAY_JSON_URL= \
    APP_TITLE="Glass Todo"

VOLUME ["/data"]
EXPOSE 3000

CMD ["npm", "start"]
