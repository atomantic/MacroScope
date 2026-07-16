import type { Ledger } from "../core/ledger.js";
import type { JournalEvent, Posting } from "../core/types.js";
import { assertLedgerInvariants } from "../core/invariants.js";
import { householdAccounts, SYSTEM_ACCOUNTS } from "./accounts.js";

export interface SettlementContext {
  readonly tick: number;
  readonly eventId: string;
}

const positiveAmount = (amount: number): void => {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Settlement amount must be finite and positive.");
  }
};

const commit = (ledger: Ledger, event: JournalEvent): void => {
  ledger.apply(event);
  assertLedgerInvariants(ledger);
};

export const originateCollateralizedLoan = (
  ledger: Ledger,
  householdId: string,
  amount: number,
  context: SettlementContext,
): void => {
  positiveAmount(amount);
  const household = householdAccounts(householdId);
  commit(ledger, {
    id: context.eventId,
    tick: context.tick,
    layer: "transaction",
    cause: "loan-origination",
    description: `${householdId} originates a collateralized loan.`,
    metadata: { householdId, amount },
    postings: [
      debit(SYSTEM_ACCOUNTS.bankLoans, amount),
      credit(SYSTEM_ACCOUNTS.bankDeposits, amount),
      debit(household.deposits, amount),
      credit(household.loans, amount),
    ],
  });
};

export const payTaxFromDeposits = (
  ledger: Ledger,
  householdId: string,
  amount: number,
  context: SettlementContext,
): void => {
  positiveAmount(amount);
  const household = householdAccounts(householdId);
  commit(ledger, {
    id: context.eventId,
    tick: context.tick,
    layer: "transaction",
    cause: "tax-payment",
    description: `${householdId} pays wealth tax from deposits.`,
    metadata: { householdId, amount },
    postings: [
      debit(household.taxExpense, amount),
      credit(household.deposits, amount),
      debit(SYSTEM_ACCOUNTS.bankDeposits, amount),
      credit(SYSTEM_ACCOUNTS.bankReserves, amount),
      debit(SYSTEM_ACCOUNTS.treasury, amount),
      credit(SYSTEM_ACCOUNTS.taxIncome, amount),
      debit(SYSTEM_ACCOUNTS.reserveLiability, amount),
      credit(SYSTEM_ACCOUNTS.treasuryLiability, amount),
    ],
  });
};

export const distributeUbi = (
  ledger: Ledger,
  recipients: Readonly<Record<string, number>>,
  context: SettlementContext,
): void => {
  const entries = Object.entries(recipients).filter(([, amount]) => amount > 0);
  if (entries.length === 0) throw new Error("UBI requires at least one positive payment.");
  const total = entries.reduce((sum, [, amount]) => {
    positiveAmount(amount);
    return sum + amount;
  }, 0);
  const householdPostings: Posting[] = entries.flatMap(([householdId, amount]) => [
    debit(householdAccounts(householdId).deposits, amount),
    credit(householdAccounts(householdId).ubiIncome, amount),
  ]);
  commit(ledger, {
    id: context.eventId,
    tick: context.tick,
    layer: "transaction",
    cause: "ubi",
    description: "Treasury distributes UBI through the commercial bank.",
    metadata: { recipients: entries.length, amount: total },
    postings: [
      debit(SYSTEM_ACCOUNTS.ubiExpense, total),
      credit(SYSTEM_ACCOUNTS.treasury, total),
      debit(SYSTEM_ACCOUNTS.treasuryLiability, total),
      credit(SYSTEM_ACCOUNTS.reserveLiability, total),
      debit(SYSTEM_ACCOUNTS.bankReserves, total),
      credit(SYSTEM_ACCOUNTS.bankDeposits, total),
      ...householdPostings,
    ],
  });
};

export const payGovernmentOperations = (
  ledger: Ledger,
  amount: number,
  context: SettlementContext,
): void => {
  positiveAmount(amount);
  commit(ledger, {
    id: context.eventId,
    tick: context.tick,
    layer: "transaction",
    cause: "government-operations",
    description:
      "Treasury pays firms for public services delivery, administration, and leakage.",
    metadata: { amount },
    postings: [
      debit(SYSTEM_ACCOUNTS.operationsExpense, amount),
      credit(SYSTEM_ACCOUNTS.treasury, amount),
      debit(SYSTEM_ACCOUNTS.treasuryLiability, amount),
      credit(SYSTEM_ACCOUNTS.reserveLiability, amount),
      debit(SYSTEM_ACCOUNTS.bankReserves, amount),
      credit(SYSTEM_ACCOUNTS.bankDeposits, amount),
      debit(SYSTEM_ACCOUNTS.firmDeposits, amount),
      credit(SYSTEM_ACCOUNTS.firmOperationsIncome, amount),
    ],
  });
};

export const transferPublicEquityForDeposits = (
  ledger: Ledger,
  sellerId: string,
  buyerId: string,
  amount: number,
  context: SettlementContext,
): void => {
  positiveAmount(amount);
  if (sellerId === buyerId) throw new Error("Buyer and seller must be different households.");
  const seller = householdAccounts(sellerId);
  const buyer = householdAccounts(buyerId);
  commit(ledger, {
    id: context.eventId,
    tick: context.tick,
    layer: "transaction",
    cause: "voluntary-trade",
    description: `${sellerId} sells public equity to ${buyerId}.`,
    metadata: { sellerId, buyerId, amount },
    postings: [
      debit(seller.deposits, amount),
      credit(seller.publicEquity, amount),
      debit(buyer.publicEquity, amount),
      credit(buyer.deposits, amount),
    ],
  });
};

export const repayCollateralizedLoan = (
  ledger: Ledger,
  householdId: string,
  amount: number,
  context: SettlementContext,
): void => {
  positiveAmount(amount);
  const household = householdAccounts(householdId);
  commit(ledger, {
    id: context.eventId,
    tick: context.tick,
    layer: "transaction",
    cause: "loan-repayment",
    description: `${householdId} repays a collateralized loan.`,
    metadata: { householdId, amount },
    postings: [
      debit(household.loans, amount),
      credit(household.deposits, amount),
      debit(SYSTEM_ACCOUNTS.bankDeposits, amount),
      credit(SYSTEM_ACCOUNTS.bankLoans, amount),
    ],
  });
};

export const payCollateralizedLoanInterest = (
  ledger: Ledger,
  householdId: string,
  amount: number,
  context: SettlementContext,
): void => {
  positiveAmount(amount);
  const household = householdAccounts(householdId);
  commit(ledger, {
    id: context.eventId,
    tick: context.tick,
    layer: "transaction",
    cause: "loan-interest-payment",
    description: `${householdId} pays interest retained by the commercial bank.`,
    metadata: { householdId, amount },
    postings: [
      debit(household.interestExpense, amount),
      credit(household.deposits, amount),
      debit(SYSTEM_ACCOUNTS.bankDeposits, amount),
      credit(SYSTEM_ACCOUNTS.bankInterestIncome, amount),
    ],
  });
};

const debit = (accountId: string, amount: number): Posting => ({
  accountId,
  side: "debit",
  amount,
});

const credit = (accountId: string, amount: number): Posting => ({
  accountId,
  side: "credit",
  amount,
});
