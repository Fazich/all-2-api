FROM node:20-alpine

WORKDIR /app

# 复制 package.json
COPY package*.json ./

# 安装依赖
RUN npm install --production

# 复制源代码
COPY src ./src

# 暴露端口
EXPOSE 13003

# 启动命令
CMD ["node", "src/server.js"]
