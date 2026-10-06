import fs from "fs";
import path from "path";

export interface OfferingConfig {
  name: string;
  offering?: string;
  description: string;
  fee?: number;
  feeType?: string;
  feeValue?: number;
  /** Extra amount (human-readable units of the payment mint) the offering
   *  escrows on top of the client's principal, e.g. a gas reserve. Only
   *  advertised: buyers add it to the budget they expect (the Openmoon app
   *  blocks auto-approval of a larger budget), so return the matching
   *  `budgetOverride` from prepareAgreement() to actually escrow it.
   *  Optional; defaults to 0. */
  budgetReserve?: number;

  slaMinutes?: number;
  requiredFunds?: boolean;
  supportedMints?: string[];
  requirement?: Record<string, any>;
  deliverable?: Record<string, any>;
}

export interface LoadedOffering {
  config: OfferingConfig;
  handlers: any;
}

export async function loadOffering(
  offeringName: string,
  agentDirName: string
): Promise<LoadedOffering> {
  // Sanitize to prevent path traversal
  const safeName = path.basename(offeringName);
  const safeDir = path.basename(agentDirName);
  const offeringsBase = path.resolve(__dirname, "..", "offerings", safeDir, safeName);
  const configPath = path.join(offeringsBase, "offering.json");
  const handlersPath = path.join(offeringsBase, "handlers.ts");

  if (!fs.existsSync(configPath)) throw new Error(`No offering.json at ${configPath}`);
  if (!fs.existsSync(handlersPath)) throw new Error(`No handlers.ts at ${handlersPath}`);

  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const handlers = await import(handlersPath);

  if (typeof handlers.executeJob !== "function") {
    throw new Error(`handlers.ts must export executeJob()`);
  }

  return { config, handlers };
}

export function listOfferings(agentDirName: string): string[] {
  const offeringsBase = path.resolve(__dirname, "..", "offerings", agentDirName);
  if (!fs.existsSync(offeringsBase)) return [];

  return fs
    .readdirSync(offeringsBase, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => fs.existsSync(path.join(offeringsBase, d.name, "offering.json")))
    .map((d) => d.name);
}

export interface ResourceConfig {
  name: string;
  description: string;
  url: string;
}

export function listResources(): ResourceConfig[] {
  const resourcesBase = path.resolve(__dirname, "..", "resources");
  if (!fs.existsSync(resourcesBase)) return [];

  return fs
    .readdirSync(resourcesBase, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const jsonPath = path.join(resourcesBase, d.name, "resources.json");
      if (!fs.existsSync(jsonPath)) return null;
      try {
        const config = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
        if (!config.name || !config.url) return null;
        return { name: config.name, description: config.description || "", url: config.url } as ResourceConfig;
      } catch {
        return null;
      }
    })
    .filter(Boolean) as ResourceConfig[];
}
