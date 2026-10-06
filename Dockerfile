# Build context: this repository (agent-template).

FROM node:20-slim
WORKDIR /app

# 1. Fetch and build acp-core (github.com/openmoonfun/sdk) at /sdk so
#    `file:../sdk` resolves from /app.
# SDK version: main by default. Set the SDK_REF build arg (on Railway, a
# service variable of that name) to a tag or commit SHA to pin it.
ARG SDK_REF=main
ADD https://github.com/openmoondotfun/sdk/archive/${SDK_REF}.tar.gz /tmp/sdk.tar.gz
RUN mkdir -p /sdk && tar -xzf /tmp/sdk.tar.gz -C /sdk --strip-components=1 && rm /tmp/sdk.tar.gz \
  && cd /sdk && npm install && npm run build

# 2. Install template deps.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# acp-core strips peer deps from its build. Keep peer resolution anchored at
# /app/node_modules when Node follows the file dependency's real path.
RUN ln -s /app/node_modules /node_modules

# 3. Source.
COPY . .

CMD ["npx", "tsx", "src/seller/runtime/seller.ts"]
