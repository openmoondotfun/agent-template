import { getClient } from "../lib/client";
import { output, heading, log, colors } from "../lib/output";

export interface SearchOptions {
  page?: number;
  pageSize?: number;
}

interface OfferingResult {
  name: string;
  description: string;
  fee: number;
  feeType: string;
  slaMinutes: number;
  requiredFunds: boolean;
  requirement: Record<string, any>;
  deliverable: Record<string, any>;
}

interface Agent {
  address: string;
  creator: string;
  provider: string;
  name: string;
  symbol: string;
  uri: string;
  mint: string | null;
  description: string;
  status: string;
  createdAt: string;
  offerings: OfferingResult[];
}

interface SearchResponse {
  data: Agent[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function formatTable(agents: Agent[]): void {
  const header = {
    rank: "#",
    name: "Name",
    symbol: "Symbol",
    address: "Address",
    provider: "Provider",
    status: "Status",
  };

  const w = { rank: 4, name: 20, symbol: 10, address: 14, provider: 14, status: 10 };

  const row = (r: typeof header) =>
    `  ${r.rank.toString().padStart(w.rank)}  ` +
    `${truncate(r.name, w.name).padEnd(w.name)}  ` +
    `${truncate(r.symbol, w.symbol).padEnd(w.symbol)}  ` +
    `${truncate(r.address, w.address).padEnd(w.address)}  ` +
    `${truncate(r.provider, w.provider).padEnd(w.provider)}  ` +
    `${r.status.toString().padEnd(w.status)}`;

  log(colors.dim(row(header)));

  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    log(
      row({
        rank: String(i + 1),
        name: a.name,
        symbol: a.symbol,
        address: a.address.slice(0, 12) + "…",
        provider: a.provider.slice(0, 12) + "…",
        status: a.status,
      })
    );
  }
}

function formatPrice(fee: number, feeType: string): string {
  if (feeType === "percentage") return `${(fee * 100).toFixed(1)}%`;
  return `${fee} SOL`;
}

function formatDetails(agents: Agent[]): void {
  for (const a of agents) {
    log(`\n  ${colors.bold(a.name)} (${a.symbol})`);
    log(`  Address:  ${a.address}`);
    log(`  Provider: ${a.provider}`);
    if (a.description) {
      log(`  ${colors.dim(a.description.split("\n")[0])}`);
    }

    const offerings = a.offerings ?? [];
    if (offerings.length > 0) {
      log("    Offerings:");
      for (const o of offerings) {
        const fee = formatPrice(o.fee, o.feeType);
        const funds = o.requiredFunds ? " [requires funds]" : "";
        log(`      - ${o.name} (${fee}${funds})`);
        if (o.description) {
          log(`        ${o.description}`);
        }
        if (o.requirement && Object.keys(o.requirement).length > 0) {
          const req = JSON.stringify(o.requirement, null, 2)
            .split("\n")
            .join("\n          ");
          log(`        Requirement: ${req}`);
        }
      }
    }
  }
}

export async function search(query: string, opts: SearchOptions = {}) {
  const { data } = await getClient().get<SearchResponse>("/acp/search", {
    params: {
      q: query || undefined,
      page: opts.page || 1,
      pageSize: opts.pageSize || 10,
    },
  });

  output(data, (d: SearchResponse) => {
    heading(`Search results${query ? ` for "${query}"` : ""}`);

    if (d.data.length === 0) {
      log("  No agents found");
      return;
    }

    log("");
    formatTable(d.data);
    formatDetails(d.data);
    log(colors.dim(`\n  Page ${d.pagination.page} · ${d.pagination.total} total`));
    log("");
  });
}
