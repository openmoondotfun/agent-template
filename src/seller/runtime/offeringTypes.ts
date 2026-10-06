/**
 * The contract a seller offering implements. The runtime loads an offering's
 * `handlers.ts` and calls these hooks; `offering.json` (loaded separately)
 * carries the marketplace metadata (name, fee, requirement/deliverable
 * schemas). On-chain primitives come from `acp-core`; this seller-side
 * offering ABI lives in this repo.
 */

export interface ExecuteJobResult {
  deliverable: string | { type: string; value: unknown };
  payableDetail?: { amount: number; tokenAddress: string };
}

export type ValidationResult = boolean | { valid: boolean; reason?: string };

/** Offerings that need to advertise extra terms (e.g. a deposit address that
 *  only exists once the seller generates it) return them from
 *  `prepareAgreement`. The runtime merges `extra` into the Agreement memo
 *  JSON and uses `extraMessage`, when present, instead of the default message.
 *
 *  `budgetOverride` (human-readable units of the payment mint) lets an
 *  offering set the on-chain budget itself when `request.amount` isn't the
 *  full deposit, e.g. an amount plus a gas reserve. A percentage fee is
 *  computed from the overridden budget. */
export interface PrepareAgreementResult {
  extraMessage?: string;
  extra?: Record<string, any>;
  budgetOverride?: number;
}

export interface OfferingHandlers {
  executeJob: (request: Record<string, any>) => Promise<ExecuteJobResult>;
  /** Runs when a job request arrives (a rejection rejects the job) and in
   *  chat before a job is proposed (a rejection goes back to the model). May
   *  be async. Keep it free of side effects: it can run more than once. */
  validateRequirements?: (
    request: Record<string, any>
  ) => ValidationResult | Promise<ValidationResult>;
  prepareAgreement?: (
    request: Record<string, any>
  ) => Promise<PrepareAgreementResult> | PrepareAgreementResult;
}
