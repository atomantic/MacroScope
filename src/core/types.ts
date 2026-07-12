export type EntityKind =
  | "household"
  | "bank"
  | "government"
  | "central-bank"
  | "firm";

export type AccountClass = "asset" | "liability" | "equity" | "income" | "expense";

export type Instrument =
  | "deposit"
  | "collateralized-loan"
  | "central-bank-reserve"
  | "treasury-account"
  | "public-equity"
  | "productive-capital"
  | "government-security";

export type ClaimSide = "holder" | "issuer";
export type ReconciliationFlow = "tax" | "ubi";
export type PostingSide = "debit" | "credit";
export type EventLayer = "transaction" | "revaluation" | "other-volume";

export type EventCause =
  | "opening-balance"
  | "tax-assessment"
  | "tax-payment"
  | "ubi"
  | "voluntary-trade"
  | "loan-origination"
  | "loan-repayment"
  | "margin-call"
  | "default"
  | "policy-rate"
  | "shock";

export interface EntityDefinition {
  readonly id: string;
  readonly kind: EntityKind;
  readonly label: string;
}

export interface AccountDefinition {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly class: AccountClass;
  readonly instrument?: Instrument;
  readonly claimSide?: ClaimSide;
  readonly counterpartyId?: string;
  readonly reconciliation?: {
    readonly flow: ReconciliationFlow;
    readonly side: "source" | "destination";
  };
  readonly allowNegative?: boolean;
}

export interface Posting {
  readonly accountId: string;
  readonly side: PostingSide;
  readonly amount: number;
}

export interface JournalEvent {
  readonly id: string;
  readonly tick: number;
  readonly layer: EventLayer;
  readonly cause: EventCause;
  readonly description: string;
  readonly postings: readonly Posting[];
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface RecordedEvent extends JournalEvent {
  readonly sequence: number;
}

export interface AccountSnapshot extends AccountDefinition {
  readonly balance: number;
}

export interface LedgerSnapshot {
  readonly sequence: number;
  readonly accounts: readonly AccountSnapshot[];
  readonly events: readonly RecordedEvent[];
}

export interface InvariantFailure {
  readonly invariant: string;
  readonly message: string;
  readonly residual?: number;
}
