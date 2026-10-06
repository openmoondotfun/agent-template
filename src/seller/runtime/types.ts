export enum AcpJobPhase {
  REQUEST = "request",
  NEGOTIATION = "negotiation",
  TRANSACTION = "transaction",
  EVALUATION = "evaluation",
  COMPLETED = "completed",
  REJECTED = "rejected",
}

export interface AcpJobEventData {
  jobAddress: string;
  phase: string;
  provider?: string;
  memoType?: string;
}

export enum SocketEvent {
  JOB_CREATED = "job:created",
  JOB_PHASE = "job:phase",
  MEMO_CREATED = "memo:created",
  JOB_BUDGET = "job:budget",
}
