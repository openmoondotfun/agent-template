#!/usr/bin/env npx tsx
import "dotenv/config";
import { setJsonMode, error, log } from "../src/lib/output";
import { positionalWords } from "../src/lib/args";
import * as walletCmd from "../src/commands/wallet";
import * as job from "../src/commands/job";
import * as searchCmd from "../src/commands/search";
import * as serve from "../src/commands/serve";
import * as sell from "../src/commands/sell";
import * as resource from "../src/commands/resource";
import * as profile from "../src/commands/profile";
import * as setup from "../src/commands/setup";
import * as agentCmd from "../src/commands/agent";
import * as deploy from "../src/commands/deploy";
import * as reviewCmd from "../src/commands/review";

const args = process.argv.slice(2);

// Global flags
if (args.includes("--json") || process.env.ACP_JSON === "1") {
  setJsonMode(true);
  const idx = args.indexOf("--json");
  if (idx !== -1) args.splice(idx, 1);
}

if (args.includes("--version") || args.includes("-v")) {
  log("acp v0.2.0");
  process.exit(0);
}

const command = args[0];
const sub = args[1];

function flag(name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(name: string): boolean {
  return args.includes(name);
}

async function main() {
  switch (command) {
    // ─── Setup ──────────────────────────────────────────────
    case "setup":
      await setup.setup();
      break;

    case "whoami":
      await setup.whoami();
      break;

    // ─── Agent Management ───────────────────────────────────
    case "agent": {
      switch (sub) {
        case "list":
          await agentCmd.list();
          break;
        case "switch": {
          const name = args[2];
          if (!name) { error("Usage: acp agent switch <name>"); process.exit(1); }
          await agentCmd.switchAgent(name);
          break;
        }
        case "create": {
          const name = args[2];
          if (!name) { error("Usage: acp agent create <name>"); process.exit(1); }
          await agentCmd.create(name);
          break;
        }
        case "import": {
          const name = args[2];
          // --mint is the older name of the flag; it takes a token mint too.
          const id = flag("--address") || flag("--mint");
          if (!name || !id) { error("Usage: acp agent import <name> --address <agent-address>"); process.exit(1); }
          await agentCmd.importAgent(name, id);
          break;
        }
        case "claim-fees":
          await agentCmd.claimFees(flag("--mint"));
          break;
        default:
          error(`Unknown agent command: ${sub}`);
          log("Commands: list, switch, create, import, claim-fees");
          process.exit(1);
      }
      break;
    }

    // ─── Wallet ─────────────────────────────────────────────
    case "wallet": {
      switch (sub) {
        case "balance":
          await walletCmd.balance();
          break;
        case "airdrop":
          await walletCmd.airdrop(args[2] ? Number(args[2]) : undefined);
          break;
        default:
          await walletCmd.address();
          break;
      }
      break;
    }

    // ─── Jobs ───────────────────────────────────────────────
    case "job": {
      switch (sub) {
        case "create": {
          const agentAddress = args[2];
          // The provider is optional: create() reads the agent's on-chain one.
          const provider = args[3] && !args[3].startsWith("--") ? args[3] : undefined;
          if (!agentAddress || agentAddress.startsWith("--")) {
            error("Usage: acp job create <agent> [provider] [--requirements '<json>'] [--evaluator <addr>] [--expiry <unix-seconds>] [--payment-mint <mint>] [--isAutomated true]");
            process.exit(1);
          }
          await job.create(agentAddress, provider, {
            requirements: flag("--requirements"),
            evaluator: flag("--evaluator"),
            expiredAt: flag("--expiry") ? Number(flag("--expiry")) : undefined,
            isAutomated: flag("--isAutomated") === "true",
            paymentMint: flag("--payment-mint"),
          });
          break;
        }
        case "status": {
          const id = args[2];
          if (!id) { error("Usage: acp job status <job>"); process.exit(1); }
          await job.status(id);
          break;
        }
        case "accept": {
          const id = args[2];
          if (!id) { error("Usage: acp job accept <job> [--reject] [--reason 'text']"); process.exit(1); }
          await job.accept(id, !hasFlag("--reject"), flag("--reason"));
          break;
        }
        case "memo": {
          const id = args[2];
          const type = args[3];
          const content = args[4];
          if (!id || !type || !content) {
            error("Usage: acp job memo <job> <type> '<content>'  (<type>: jobRequest|agreement|transaction|deliverable|general)");
            process.exit(1);
          }
          await job.memo(id, type, content);
          break;
        }
        case "sign": {
          const id = args[2];
          const memoId = args[3];
          if (!id || !memoId) {
            error("Usage: acp job sign <job> <memoId> [--reject] [--reason 'text']");
            process.exit(1);
          }
          await job.sign(id, memoId, !hasFlag("--reject"), flag("--reason"));
          break;
        }
        case "budget": {
          const id = args[2];
          const amount = args[3];
          const fee = args[4] || "0";
          if (!id || !amount) { error("Usage: acp job budget <job> <amount> [fee]"); process.exit(1); }
          await job.setBudget(id, Number(amount), Number(fee));
          break;
        }
        case "deposit": {
          const id = args[2];
          if (!id) { error("Usage: acp job deposit <job>"); process.exit(1); }
          await job.deposit(id);
          break;
        }
        case "claim": {
          const id = args[2];
          if (!id) { error("Usage: acp job claim <job>"); process.exit(1); }
          await job.claim(id);
          break;
        }
        case "refund": {
          const id = args[2];
          if (!id) { error("Usage: acp job refund <job> [--amount <lamports>]"); process.exit(1); }
          const amountFlag = flag("--amount");
          const amount = amountFlag ? Number(amountFlag) : undefined;
          // Base units of the payment mint: a positive whole number.
          if (amount != null && (!Number.isSafeInteger(amount) || amount <= 0)) {
            error(`Invalid --amount: ${amountFlag} (a positive whole number of base units)`);
            process.exit(1);
          }
          await job.refund(id, amount);
          break;
        }
        case "claim-fee": {
          const id = args[2];
          if (!id) { error("Usage: acp job claim-fee <job>"); process.exit(1); }
          await job.claimFee(id);
          break;
        }
        case "cancel": {
          const id = args[2];
          if (!id) { error("Usage: acp job cancel <job>"); process.exit(1); }
          await job.cancel(id);
          break;
        }
        case "pay": {
          const id = args[2];
          if (!id) { error("Usage: acp job pay <job> [--accept false] [--content 'reason']"); process.exit(1); }
          const accept = flag("--accept") !== "false";
          await job.pay(id, accept, flag("--content"));
          break;
        }
        case "active":
          await job.active({ page: Number(flag("--page") || 1), role: flag("--role") });
          break;
        case "completed":
          await job.completed({ page: Number(flag("--page") || 1), role: flag("--role") });
          break;
        default:
          error(`Unknown job command: ${sub}`);
          log("Commands: create, status, accept, memo, sign, budget, pay, deposit, claim, claim-fee, refund, cancel, active, completed");
          process.exit(1);
      }
      break;
    }

    // ─── Search ─────────────────────────────────────────────
    case "browse":
    case "search": {
      const query = positionalWords(args.slice(1), ["--page", "--page-size"]).join(" ");
      await searchCmd.search(query, {
        page: flag("--page") ? Number(flag("--page")) : undefined,
        pageSize: flag("--page-size") ? Number(flag("--page-size")) : undefined,
      });
      break;
    }

    // ─── Profile ────────────────────────────────────────────
    case "profile": {
      switch (sub) {
        case "update": {
          const key = args[2];
          const value = args.slice(3).filter((a) => !a.startsWith("--")).join(" ");
          await profile.update(key, value);
          break;
        }
        default:
          await profile.show();
          break;
      }
      break;
    }

    // ─── Sell (Offerings & Resources) ───────────────────────
    case "sell": {
      if (sub === "resource") {
        const resourceSub = args[2];
        const resourceName = args[3];
        switch (resourceSub) {
          case "init":
            await sell.resourceInit(resourceName);
            break;
          case "create":
            await sell.resourceCreate(resourceName);
            break;
          case "delete":
            await sell.resourceDelete(resourceName);
            break;
          case "list":
            await sell.resourceList();
            break;
          default:
            error(`Unknown resource command: ${resourceSub}`);
            log("Commands: init, create, delete, list");
            process.exit(1);
        }
        break;
      }

      const offeringName = args[2];
      switch (sub) {
        case "init":
          await sell.init(offeringName);
          break;
        case "create":
          await sell.create(offeringName);
          break;
        case "delete":
          await sell.del(offeringName);
          break;
        case "list":
          await sell.list();
          break;
        case "inspect":
          await sell.inspect(offeringName);
          break;
        default:
          error(`Unknown sell command: ${sub}`);
          log("Commands: init, create, delete, list, inspect, resource");
          process.exit(1);
      }
      break;
    }

    // ─── Resource Query ─────────────────────────────────────
    case "resource": {
      if (sub === "query") {
        const url = args[2];
        const paramsRaw = flag("--params");
        let params: Record<string, any> | undefined = undefined;
        if (paramsRaw) {
          try {
            const parsed = JSON.parse(paramsRaw);
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
              error("--params must be a JSON object");
              process.exit(1);
            }
            params = parsed;
          } catch (e: any) {
            error(`Invalid JSON in --params: ${e.message}`);
            process.exit(1);
          }
        }
        await resource.query(url, params);
      } else {
        error("Usage: acp resource query <url> [--params '<json>']");
        process.exit(1);
      }
      break;
    }

    // ─── Serve ──────────────────────────────────────────────
    case "serve": {
      if (sub === "deploy") {
        const deploySub = args[2];

        // ── Railway (self-hosted) deploy ──
        if (deploySub !== "railway") {
          error("Usage: acp serve deploy railway [subcommand]");
          process.exit(1);
        }
        const railwaySub = args[3];
        switch (railwaySub) {
          case "setup":
            await deploy.setup();
            break;
          case "status":
            await deploy.status();
            break;
          case "logs":
            await deploy.logs(hasFlag("-f") || hasFlag("--follow"), Number(flag("--lines")) || 100);
            break;
          case "teardown":
            await deploy.teardown();
            break;
          case "env": {
            const envSub = args[4];
            if (envSub === "set") {
              await deploy.envSet(args[5]);
            } else if (envSub === "delete") {
              await deploy.envDelete(args[5]);
            } else {
              await deploy.env();
            }
            break;
          }
          case undefined:
          case "--replace":
            await deploy.deploy({ replace: hasFlag("--replace") });
            break;
          default:
            error(`Unknown deploy command: ${railwaySub}`);
            log("Commands: setup, status, logs, teardown, env");
            process.exit(1);
        }
        break;
      }

      switch (sub) {
        case "start": await serve.start(hasFlag("--all")); break;
        case "stop": serve.stop(hasFlag("--all")); break;
        case "status": serve.status(hasFlag("--all")); break;
        case "logs": serve.logs(hasFlag("-f") || hasFlag("--follow"), flag("--filter"), flag("--agent") || undefined); break;
        default:
          error(`Unknown serve command: ${sub}`);
          log("Commands: start, stop, status, logs, deploy");
          process.exit(1);
      }
      break;
    }

    // ─── Review ────────────────────────────────────────────
    case "review": {
      switch (sub) {
        case "show":
          await reviewCmd.show(args[2]);
          break;
        case "job":
          await reviewCmd.job(args[2]);
          break;
        default:
          error("Usage: acp review [show <agentAddress> | job <jobAddress>]");
          process.exit(1);
      }
      break;
    }

    // ─── Help ───────────────────────────────────────────────
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      break;

    default:
      error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

function printHelp() {
  log(`
acp — Agent Commerce Protocol CLI

Usage: acp <command> [subcommand] [args] [flags]

Commands:
  setup                                Interactive setup
  whoami                               Show current agent profile

  agent list                           Show all agents
  agent create <name>                  Create a new agent
  agent import <name> --address <addr> Import an agent created in the app
  agent switch <name>                  Switch active agent
  agent claim-fees [--mint <mint>]     Withdraw the agent's job fees (creator)

  wallet [address|balance]             Wallet info
  wallet airdrop [amount]              Request SOL airdrop (devnet)

  browse <query>                       Search agents (alias: search)
    --page <n>                         Page number (default: 1)
    --page-size <n>                    Results per page (default: 10)
  profile [show]                       Show agent profile
  profile update <key> <value>         Update profile

  job create <agent> [provider]        Create a job (provider: the agent's, read on-chain)
    --requirements '<json>'            The request; must name the offering, e.g. {"offering":"<name>",...}
    --evaluator <address>              Evaluator (default: platform evaluator)
    --expiry <unix-seconds>            Deadline (default: now + 1h; must be > now + 5 min)
    --payment-mint <mint>              Payment token (default: platform's, wSOL)
    --isAutomated true                 Approve and pay once terms are proposed
  job status <job>                     Get job details
  job accept <job> [--reject] [--reason 'text']
                                       Accept/reject a job (provider)
  job memo <job> <type> '<content>'    Create a memo
    <type>: jobRequest|agreement|transaction|deliverable|general
  job sign <job> <memoId> [--reject] [--reason 'text']
                                       Sign a memo
  job budget <job> <amount> [fee]      Set budget and fee, before the Agreement (provider)
  job pay <job> [--accept false] [--content 'reason']
                                       Approve the Agreement and deposit, or reject it
  job deposit <job>                    Deposit budget + fee to escrow
  job claim <job>                      Withdraw budget from escrow (provider)
  job claim-fee <job>                  Settle a finished job: fee payout or client refund
  job refund <job> [--amount lamports] Return withdrawn budget to escrow (provider)
  job cancel <job>                     Reclaim escrow of an expired, undelivered job (client)
  job active [--role <role>] [--page N]
                                       List active jobs
  job completed [--role <role>] [--page N]
                                       List completed jobs
    <role>: client|provider|evaluator|all (default: all)
    <job> is the job address; job numbers repeat across agents

  review show <agentAddress>           Show reviews for an agent
  review job <jobAddress>              Show review for a job

  sell init <name>                     Scaffold a new offering
  sell create <name>                   Validate offering
  sell delete <name>                   Remove offering
  sell list                            List all offerings
  sell inspect <name>                  Detailed offering view
  sell resource init <name>            Scaffold a resource
  sell resource create <name>          Validate resource
  sell resource delete <name>          Remove resource
  sell resource list                   List resources

  resource query <url>                 Query a resource URL
    --params '<json>'                  Optional query params

  serve start [--all]                  Start seller (or all agents)
  serve stop [--all]                   Stop seller (or all agents)
  serve status [--all]                 Show status (or all agents)
  serve logs [-f] [--agent <name>] [--filter <text>]
                                       Show logs
  serve deploy railway [--replace]     Deploy to Railway (self-hosted)
    --replace                          Replace another agent already on the linked service
  serve deploy railway setup           Setup Railway project
  serve deploy railway status          Show deployment status
  serve deploy railway logs [-f] [--lines N]
                                       Recent deployment logs (-f: stream)
  serve deploy railway teardown        Remove deployment
  serve deploy railway env             List env vars
  serve deploy railway env set K=V     Set env var
  serve deploy railway env delete K    Delete env var

Flags:
  --json          JSON output mode
  --help, -h      Show help
  --version, -v   Show version

Environment:
  WALLET_KEY          Wallet keypair (JSON array or file path)
  PROVIDER_WALLET     Signing key used when WALLET_KEY is unset
  RPC_URL             Solana RPC URL (default: http://127.0.0.1:8899)
  ACP_API_URL         API base URL (default: http://localhost:3001)
  CHAT_URL            Chat server URL (default: http://localhost:3001)
  ANTHROPIC_API_KEY   API key for the seller's chat (chat is off without it)
  ANTHROPIC_MODEL     Chat model (default: claude-sonnet-4-6)
  POLL_INTERVAL       Seller job poll interval in ms (default: 5000)
  TRUSTED_EVALUATORS  Evaluators the seller works with, comma-separated
                      (default: the Openmoon evaluator)
  SHUTDOWN_GRACE_MS   How long a stopping seller waits for jobs in progress
                      (default: 30000)
  AGENT_DIR           Offerings folder (default: the active agent's)
  AGENT_ADDRESS       Agent address override for a hosted seller; leave unset
                      locally (it retargets sell and profile)
  ACP_JSON=1          Same as --json
  ACP_DEBUG=1         Print tolerated errors to stderr
  The environment (and .env) wins over config.json (acp setup).
  See .env.example
`);
}

// Global crash handlers — surface unhandled async errors with a consistent
// message instead of the default Node dump, and exit non-zero so CI/scripts
// can detect failure.
process.on("unhandledRejection", (reason: any) => {
  error(`Unhandled promise rejection: ${reason?.message || reason}`);
  process.exit(1);
});
process.on("uncaughtException", (err: any) => {
  error(`Uncaught exception: ${err?.message || err}`);
  process.exit(1);
});

main().catch((e) => {
  error(e.message || String(e));
  process.exit(1);
});
