FROM node:22-alpine

WORKDIR /app

# Install dependencies first (cached layer)
COPY package.json package-lock.json ./
RUN npm ci

# Copy project files
COPY . .

# Vite dev server port
EXPOSE 5173

# Default: run dev server (includes level/sprite editor save plugins)
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
