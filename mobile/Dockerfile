# syntax=docker/dockerfile:1

# Expo dev server for Expo Go. REACT_NATIVE_PACKAGER_HOSTNAME (from compose)
# makes the QR code use the PC's Wi-Fi IP.

FROM node:22-bookworm-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# 8081 = Metro bundler (what the QR code points at).
EXPOSE 8081

# poll-watch.js re-raises edits saved from Windows so Metro sees them and
# Expo Go reloads by itself (Docker doesn't pass those file events through).
CMD ["sh", "-c", "node docker/poll-watch.js & exec npm run go"]
