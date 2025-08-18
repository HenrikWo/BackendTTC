FROM python:3.11-slim

# Install piper CLI directly
RUN pip install piper-tts

# Install Node.js for our API
RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs

WORKDIR /app
COPY package.json .
RUN npm install

COPY server.js .

EXPOSE 3000

CMD ["node", "server.js"]