FROM node:alpine
COPY . /app
WORKDIR /app
RUN npm install
EXPOSE 8081
CMD ["node", "server.js"]