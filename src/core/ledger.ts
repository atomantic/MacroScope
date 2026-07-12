import type {
  AccountClass,
  AccountDefinition,
  AccountSnapshot,
  EntityDefinition,
  JournalEvent,
  LedgerSnapshot,
  Posting,
  RecordedEvent,
} from "./types.js";

export const DEFAULT_EPSILON = 1e-8;

const isDebitNormal = (accountClass: AccountClass): boolean =>
  accountClass === "asset" || accountClass === "expense";

const postingDelta = (account: AccountDefinition, posting: Posting): number => {
  const increasesBalance = isDebitNormal(account.class)
    ? posting.side === "debit"
    : posting.side === "credit";
  return increasesBalance ? posting.amount : -posting.amount;
};

export class Ledger {
  readonly #entities = new Map<string, EntityDefinition>();
  readonly #accounts = new Map<string, AccountDefinition>();
  readonly #balances = new Map<string, number>();
  readonly #events: RecordedEvent[] = [];
  readonly #eventIds = new Set<string>();
  readonly #epsilon: number;

  constructor(epsilon = DEFAULT_EPSILON) {
    if (!Number.isFinite(epsilon) || epsilon <= 0) {
      throw new Error("Ledger epsilon must be a finite positive number.");
    }
    this.#epsilon = epsilon;
  }

  get epsilon(): number {
    return this.#epsilon;
  }

  get sequence(): number {
    return this.#events.length;
  }

  get events(): readonly RecordedEvent[] {
    return this.#events;
  }

  addEntity(entity: EntityDefinition): void {
    if (this.#entities.has(entity.id)) {
      throw new Error(`Entity already exists: ${entity.id}`);
    }
    this.#entities.set(entity.id, entity);
  }

  addAccount(account: AccountDefinition, openingBalance = 0): void {
    if (!this.#entities.has(account.ownerId)) {
      throw new Error(`Unknown account owner: ${account.ownerId}`);
    }
    if (this.#accounts.has(account.id)) {
      throw new Error(`Account already exists: ${account.id}`);
    }
    if (!Number.isFinite(openingBalance)) {
      throw new Error(`Opening balance must be finite: ${account.id}`);
    }
    if (openingBalance < -this.#epsilon && !account.allowNegative) {
      throw new Error(`Negative opening balance is not allowed: ${account.id}`);
    }
    this.#accounts.set(account.id, account);
    this.#balances.set(account.id, openingBalance);
  }

  entity(id: string): EntityDefinition {
    const entity = this.#entities.get(id);
    if (!entity) throw new Error(`Unknown entity: ${id}`);
    return entity;
  }

  entities(): readonly EntityDefinition[] {
    return [...this.#entities.values()];
  }

  account(id: string): AccountDefinition {
    const account = this.#accounts.get(id);
    if (!account) throw new Error(`Unknown account: ${id}`);
    return account;
  }

  accounts(): readonly AccountSnapshot[] {
    return [...this.#accounts.values()].map((account) => ({
      ...account,
      balance: this.balance(account.id),
    }));
  }

  balance(accountId: string): number {
    const balance = this.#balances.get(accountId);
    if (balance === undefined) throw new Error(`Unknown account: ${accountId}`);
    return balance;
  }

  sumBalances(accountIds: readonly string[]): number {
    return accountIds.reduce((total, id) => total + this.balance(id), 0);
  }

  apply(event: JournalEvent): RecordedEvent {
    if (this.#eventIds.has(event.id)) {
      throw new Error(`Journal event id already exists: ${event.id}`);
    }
    if (event.postings.length < 2) {
      throw new Error(`Journal event ${event.id} must contain at least two postings.`);
    }

    let debits = 0;
    let credits = 0;
    const pending = new Map<string, number>();
    const entityDebits = new Map<string, number>();
    const entityCredits = new Map<string, number>();
    const instrumentHolderDeltas = new Map<string, number>();
    const instrumentIssuerDeltas = new Map<string, number>();

    for (const posting of event.postings) {
      if (!Number.isFinite(posting.amount) || posting.amount <= 0) {
        throw new Error(`Posting amounts must be finite and positive: ${event.id}`);
      }
      const account = this.account(posting.accountId);
      if (posting.side === "debit") {
        debits += posting.amount;
        entityDebits.set(
          account.ownerId,
          (entityDebits.get(account.ownerId) ?? 0) + posting.amount,
        );
      } else {
        credits += posting.amount;
        entityCredits.set(
          account.ownerId,
          (entityCredits.get(account.ownerId) ?? 0) + posting.amount,
        );
      }

      const current = pending.get(account.id) ?? this.balance(account.id);
      const delta = postingDelta(account, posting);
      pending.set(account.id, current + delta);
      if (account.instrument && account.claimSide) {
        const deltas =
          account.claimSide === "holder"
            ? instrumentHolderDeltas
            : instrumentIssuerDeltas;
        deltas.set(account.instrument, (deltas.get(account.instrument) ?? 0) + delta);
      }
    }

    if (Math.abs(debits - credits) > this.#epsilon) {
      throw new Error(
        `Unbalanced journal event ${event.id}: debits=${debits}, credits=${credits}`,
      );
    }

    for (const entityId of new Set([...entityDebits.keys(), ...entityCredits.keys()])) {
      const entityDebit = entityDebits.get(entityId) ?? 0;
      const entityCredit = entityCredits.get(entityId) ?? 0;
      if (Math.abs(entityDebit - entityCredit) > this.#epsilon) {
        throw new Error(
          `Event ${event.id} is not balanced for ${entityId}: debits=${entityDebit}, credits=${entityCredit}`,
        );
      }
    }

    for (const instrument of new Set([
      ...instrumentHolderDeltas.keys(),
      ...instrumentIssuerDeltas.keys(),
    ])) {
      const holderDelta = instrumentHolderDeltas.get(instrument) ?? 0;
      const issuerDelta = instrumentIssuerDeltas.get(instrument) ?? 0;
      if (Math.abs(holderDelta - issuerDelta) > this.#epsilon) {
        throw new Error(
          `Event ${event.id} breaks the ${instrument} instrument mirror: holder delta=${holderDelta}, issuer delta=${issuerDelta}`,
        );
      }
    }

    for (const [accountId, nextBalance] of pending) {
      const account = this.account(accountId);
      if (!account.allowNegative && nextBalance < -this.#epsilon) {
        throw new Error(
          `Event ${event.id} would overdraw ${accountId}: balance=${nextBalance}`,
        );
      }
    }

    for (const [accountId, nextBalance] of pending) {
      this.#balances.set(accountId, Math.abs(nextBalance) <= this.#epsilon ? 0 : nextBalance);
    }

    const recorded: RecordedEvent = {
      ...event,
      sequence: this.#events.length + 1,
    };
    this.#events.push(recorded);
    this.#eventIds.add(recorded.id);
    return recorded;
  }

  snapshot(): LedgerSnapshot {
    return {
      sequence: this.sequence,
      accounts: this.accounts(),
      events: this.#events.map((event) => ({ ...event, postings: [...event.postings] })),
    };
  }
}
