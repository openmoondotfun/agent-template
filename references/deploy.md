# Railway Deployment Reference

## Overview

Deploy the seller runtime to Railway for 24/7 operation. A deploy runs the active agent on the Railway service linked to this directory.

## Prerequisites

- Railway account — Hobby plan ($5/month) at [railway.com](https://railway.com)
- Railway CLI 5.x (`npm i -g @railway/cli`); the deploy uses its `railway variable` commands
- Offerings validated with `acp sell create <name>`

## Quick Start

```bash
acp serve deploy railway setup     # First-time: log in, create project, link a service
acp sell create my_offering        # Validate and publish offering
acp serve deploy railway           # Deploy
acp serve deploy railway status    # Verify
```

## Commands

| Command | Description |
|---------|-------------|
| `acp serve deploy railway setup` | Log in, create a Railway project and link a service (first-time) |
| `acp serve deploy railway [--replace]` | Deploy or redeploy the active agent; `--replace` lets it replace another agent on the linked service |
| `acp serve deploy railway status` | Show deployment status |
| `acp serve deploy railway logs [-f] [--lines N]` | Print the last 100 log lines (`--lines N` for another count) and exit; `-f` streams them |
| `acp serve deploy railway teardown` | Remove deployment |
| `acp serve deploy railway env` | List environment variables |
| `acp serve deploy railway env set K=V` | Set env var (requires redeploy) |
| `acp serve deploy railway env delete K` | Remove env var (requires redeploy) |

## Environment Variables

`acp serve deploy railway` pushes these to the linked service on every deploy, overwriting values set by hand:
- `RPC_URL`, `ACP_API_URL`, `CHAT_URL` — Solana RPC and the Openmoon indexer
- `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `POLL_INTERVAL` — when set
- `TRUSTED_EVALUATORS`, `SHUTDOWN_GRACE_MS` — when set in `.env` or the environment
- `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` — from `.env` or the environment when set; otherwise, if the service has none, the shutdown grace in seconds (30). Railway kills the old deployment right after SIGTERM unless this is set, so without it a redeploy can't let jobs in progress finish. An existing value on the service is never overwritten.
- `WALLET_KEY` — the agent's provider key (`agents.<name>.wallet` in `config.json`); a keypair file path is read and sent as its JSON array
- `AGENT_ADDRESS`, `AGENT_DIR` — the agent and its offerings folder

Values come from the environment and `.env` first, then from `config.json` (`rpc`, `apiUrl`, `chatUrl`, `anthropicApiKey`, `anthropicModel`, `pollInterval`); `RPC_URL` also takes the legacy `RPC` variable. The `WALLET_KEY` in `.env` is the creator key and is never sent. A value that isn't set anywhere is skipped and never deletes a variable already on the service. The deploy prints only the variable names, and sets them without a redeploy each: only the `railway up` that follows deploys.

The deploy stops before changing anything on Railway when there is no active agent, the agent has no address or provider key, or `RPC_URL` or `ACP_API_URL` can't be resolved (the hosted seller would fall back to localhost). It warns when `ANTHROPIC_API_KEY` is set but `CHAT_URL` is not.

Set anything else via `env set`, not in code, then redeploy:

```bash
acp serve deploy railway env set ANTHROPIC_API_KEY=<anthropic-api-key>   # only when the key isn't in .env or config.json
acp serve deploy railway env set TRUSTED_EVALUATORS=<evaluator>,<evaluator>
acp serve deploy railway           # Redeploy to pick up changes
```

`TRUSTED_EVALUATORS` defaults to the Openmoon evaluator; set it only to also accept jobs judged by other evaluators. A value in `.env` replaces the service's on the next deploy.

## One Agent per Service

The Railway CLI links this directory to a project and service; nothing about them is stored in `config.json`. Every deploy writes the active agent's `WALLET_KEY`, `AGENT_ADDRESS` and `AGENT_DIR` to the linked service, so one service runs one agent. When the service's `AGENT_ADDRESS` belongs to another agent, the deploy stops and names both agents; `--replace` deploys anyway and takes the other agent's seller off that service. If the deploy can't read the service's variables, it warns and skips this check.

To run another agent, give it its own service: create one with `railway add --service <name>` and link it with `railway service link <name>` (or link another project with `railway link`), then run `acp agent switch <name> && acp serve deploy railway`. Link the first agent's service again before redeploying the first agent, or deploy each agent from its own checkout.

## Adding New Offerings

After adding a new offering locally:

```bash
acp sell create new_offering       # Validate and publish
acp serve deploy railway           # Redeploy — rebuilds Docker image with full codebase
```

## Local vs. Railway

| Aspect | Local (`serve start`) | Railway (`deploy railway`) |
|--------|----------------------|--------------------------|
| Availability | When machine is on | 24/7 |
| Config source | `.env` and `config.json` | Service variables, pushed by each deploy |
| Startup | Instant | ~1 min build |
| Cost | Free | $5/month |

The runtime is identical: same code, same offerings. Run each agent in one place at a time. A local seller and a Railway seller for the same agent poll the same jobs with the same provider key and work on them in parallel, posting duplicate memos or running a handler twice. Stop the local one with `acp serve stop` once the Railway one is up.

## State and Redeploys

Every deploy starts from a fresh image, so anything an offering writes under the app directory (databases, caches, per-job keys) is lost unless a Railway volume is mounted there or the data lives in an external store. For per-job wallets, prefer acp-core's `deriveJobKeypair(providerKeypair, jobAddress)` to storing keys: any process holding the provider key can recompute it.

During a deploy, the old and the new seller run side by side for a moment. The chat server talks to the newer one (each seller sends its start time when it connects), but both work on jobs, so state kept in local files or single-writer databases must tolerate two processes.

## Docker

The included `Dockerfile` downloads and builds the SDK from [github.com/openmoonfun/sdk](https://github.com/openmoondotfun/sdk) at `/sdk`, so `file:../sdk` resolves, installs the template's dependencies, copies the repo and runs the seller runtime (`npx tsx src/seller/runtime/seller.ts`). The build context is this repository.

The SDK version is the `SDK_REF` build argument: `main` by default, or a tag or commit SHA to pin it. On Railway, set a service variable of that name (`acp serve deploy railway env set SDK_REF=<sha>`), which Railway passes to the build argument. A ref that doesn't exist fails the build where the SDK is downloaded.

`.dockerignore` keeps `.env` and `.env.*`, `config.json`, local keypair files (`.keys/`, `*.pem`), logs and `node_modules` out of the image, so a hosted seller gets its settings only from environment variables. `acp serve deploy railway` writes the same `.dockerignore`, and a `Dockerfile` like the included one, when either is missing.

On another host, run the image, or `npm start` (the seller in the foreground), with `WALLET_KEY` set to the agent's provider key (`agents.<name>.wallet` in `config.json`), plus `AGENT_ADDRESS`, `AGENT_DIR`, `RPC_URL`, `ACP_API_URL`, `CHAT_URL` and, for chat, `ANTHROPIC_API_KEY`. `npm start` also loads `.env`; a variable set in the environment wins over it, but without one the seller would sign with the `.env` `WALLET_KEY`, the creator key, which can't act as the provider.
