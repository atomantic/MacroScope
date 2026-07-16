import { checkLedgerInvariants, measureLedgerResiduals } from "../core/invariants.js";
import { Ledger } from "../core/ledger.js";
import type { AccountDefinition, Posting } from "../core/types.js";

export interface OpenEconomyFlows {
  readonly foreignAssetPurchases: number;
  readonly foreignTreasuryPurchases: number;
  readonly residentCapitalOutflow: number;
  readonly repatriatedCapital: number;
}

export interface OpenEconomyLedgerAudit {
  readonly trialBalanceResidual: number;
  readonly instrumentResidual: number;
  readonly events: number;
  readonly failures: readonly string[];
  readonly passed: boolean;
}

const US = "us-households";
const BANK = "us-bank";
const TREASURY = "us-treasury";
const CENTRAL_BANK = "us-central-bank";
const FIRMS = "us-firms";
const ROW = "rest-of-world";

const A = {
  domesticDeposits: `${US}:deposits`,
  domesticClaims: `${US}:domestic-claims`,
  foreignClaims: `${US}:foreign-claims`,
  householdEquity: `${US}:opening-equity`,
  bankDomesticDeposits: `${BANK}:domestic-deposits`,
  bankForeignDeposits: `${BANK}:foreign-deposits`,
  bankReserves: `${BANK}:reserves`,
  treasuryAccount: `${TREASURY}:account`,
  treasuryDebt: `${TREASURY}:debt`,
  treasuryEquity: `${TREASURY}:opening-equity`,
  centralTreasuryLiability: `${CENTRAL_BANK}:treasury-liability`,
  centralReserveLiability: `${CENTRAL_BANK}:reserve-liability`,
  centralForeignReserve: `${CENTRAL_BANK}:foreign-reserve`,
  firmCapital: `${FIRMS}:capital`,
  firmClaims: `${FIRMS}:issued-claims`,
  foreignDeposits: `${ROW}:deposits`,
  foreignDomesticClaims: `${ROW}:domestic-claims`,
  foreignTreasurySecurities: `${ROW}:treasury-securities`,
  foreignClaimsIssued: `${ROW}:foreign-claims-issued`,
  foreignEquity: `${ROW}:opening-equity`,
} as const;

const add = (ledger: Ledger, definition: AccountDefinition, balance = 0): void =>
  ledger.addAccount(definition, balance);
const debit = (accountId: string, amount: number): Posting => ({ accountId, side: "debit", amount });
const credit = (accountId: string, amount: number): Posting => ({ accountId, side: "credit", amount });

/**
 * Replay the aggregate cross-border legs through the same double-entry kernel
 * used by the domestic audit. The opening balances are deliberately neutral
 * funding balances, so this verifies the transactions rather than asserting a
 * real-world foreign-asset starting stock that this first aggregate sector does
 * not yet calibrate.
 */
export const auditOpenEconomyFlows = (flows: OpenEconomyFlows): OpenEconomyLedgerAudit => {
  const values = Object.values(flows);
  const scale = values.reduce((sum, value) => sum + Math.abs(value), 0);
  const epsilon = Math.max(1e-6, scale * 1e-12);
  const foreignFunding = Math.max(1, flows.foreignAssetPurchases + flows.foreignTreasuryPurchases);
  const domesticFunding = Math.max(1, flows.residentCapitalOutflow);
  const domesticClaims = Math.max(1, flows.foreignAssetPurchases);
  const ledger = new Ledger(epsilon);
  const failures: string[] = [];

  try {
    ledger.addEntity({ id: US, kind: "household", label: "U.S. household sector" });
    ledger.addEntity({ id: BANK, kind: "bank", label: "U.S. commercial bank" });
    ledger.addEntity({ id: TREASURY, kind: "government", label: "U.S. Treasury" });
    ledger.addEntity({ id: CENTRAL_BANK, kind: "central-bank", label: "U.S. central bank" });
    ledger.addEntity({ id: FIRMS, kind: "firm", label: "U.S. domestic issuers" });
    ledger.addEntity({ id: ROW, kind: "rest-of-world", label: "Rest of world" });

    add(ledger, { id: A.domesticDeposits, ownerId: US, name: "U.S. deposits", class: "asset", instrument: "deposit", claimSide: "holder" }, domesticFunding);
    add(ledger, { id: A.domesticClaims, ownerId: US, name: "Domestic securities and housing claims", class: "asset", instrument: "public-equity", claimSide: "holder" }, domesticClaims);
    add(ledger, { id: A.foreignClaims, ownerId: US, name: "Foreign claims", class: "asset", instrument: "foreign-claim", claimSide: "holder" });
    add(ledger, { id: A.householdEquity, ownerId: US, name: "Opening net worth", class: "equity" }, domesticFunding + domesticClaims);
    add(ledger, { id: A.bankDomesticDeposits, ownerId: BANK, name: "U.S. deposits", class: "liability", instrument: "deposit", claimSide: "issuer" }, domesticFunding);
    add(ledger, { id: A.bankForeignDeposits, ownerId: BANK, name: "Foreign deposits", class: "liability", instrument: "deposit", claimSide: "issuer" }, foreignFunding);
    add(ledger, { id: A.bankReserves, ownerId: BANK, name: "Central-bank reserves", class: "asset", instrument: "central-bank-reserve", claimSide: "holder" }, domesticFunding + foreignFunding);
    add(ledger, { id: A.treasuryAccount, ownerId: TREASURY, name: "Treasury account", class: "asset", instrument: "treasury-account", claimSide: "holder" });
    add(ledger, { id: A.treasuryDebt, ownerId: TREASURY, name: "Treasury debt", class: "liability", instrument: "government-security", claimSide: "issuer" });
    add(ledger, { id: A.treasuryEquity, ownerId: TREASURY, name: "Opening fiscal balance", class: "equity" });
    add(ledger, { id: A.centralTreasuryLiability, ownerId: CENTRAL_BANK, name: "Treasury account liability", class: "liability", instrument: "treasury-account", claimSide: "issuer" });
    add(ledger, { id: A.centralReserveLiability, ownerId: CENTRAL_BANK, name: "Reserve liability", class: "liability", instrument: "central-bank-reserve", claimSide: "issuer" }, domesticFunding + foreignFunding);
    add(ledger, { id: A.centralForeignReserve, ownerId: CENTRAL_BANK, name: "Foreign reserve backing", class: "asset" }, domesticFunding + foreignFunding);
    add(ledger, { id: A.firmCapital, ownerId: FIRMS, name: "Domestic claims backing", class: "asset" }, domesticClaims);
    add(ledger, { id: A.firmClaims, ownerId: FIRMS, name: "Issued domestic claims", class: "equity", instrument: "public-equity", claimSide: "issuer" }, domesticClaims);
    add(ledger, { id: A.foreignDeposits, ownerId: ROW, name: "Foreign deposits", class: "asset", instrument: "deposit", claimSide: "holder" }, foreignFunding);
    add(ledger, { id: A.foreignDomesticClaims, ownerId: ROW, name: "Foreign-owned U.S. securities and housing claims", class: "asset", instrument: "public-equity", claimSide: "holder" });
    add(ledger, { id: A.foreignTreasurySecurities, ownerId: ROW, name: "Foreign-held Treasury securities", class: "asset", instrument: "government-security", claimSide: "holder" });
    add(ledger, { id: A.foreignClaimsIssued, ownerId: ROW, name: "Foreign claims issued to U.S. residents", class: "liability", instrument: "foreign-claim", claimSide: "issuer" });
    add(ledger, { id: A.foreignEquity, ownerId: ROW, name: "Opening foreign net worth", class: "equity" }, foreignFunding);

    const apply = (id: string, description: string, postings: readonly Posting[]): void => {
      if (postings.length === 0) return;
      ledger.apply({ id, tick: ledger.sequence + 1, layer: "transaction", cause: "cross-border-flow", description, postings });
    };
    if (flows.foreignAssetPurchases > 0) apply("foreign-asset-purchase", "Rest of world buys U.S. securities and housing claims.", [
      debit(A.domesticDeposits, flows.foreignAssetPurchases), credit(A.domesticClaims, flows.foreignAssetPurchases),
      debit(A.bankForeignDeposits, flows.foreignAssetPurchases), credit(A.bankDomesticDeposits, flows.foreignAssetPurchases),
      debit(A.foreignDomesticClaims, flows.foreignAssetPurchases), credit(A.foreignDeposits, flows.foreignAssetPurchases),
    ]);
    if (flows.foreignTreasuryPurchases > 0) apply("foreign-treasury-purchase", "Rest of world funds new Treasury debt.", [
      debit(A.treasuryAccount, flows.foreignTreasuryPurchases), credit(A.treasuryDebt, flows.foreignTreasuryPurchases),
      debit(A.foreignTreasurySecurities, flows.foreignTreasuryPurchases), credit(A.foreignDeposits, flows.foreignTreasuryPurchases),
      debit(A.bankForeignDeposits, flows.foreignTreasuryPurchases), credit(A.bankReserves, flows.foreignTreasuryPurchases),
      debit(A.centralReserveLiability, flows.foreignTreasuryPurchases), credit(A.centralTreasuryLiability, flows.foreignTreasuryPurchases),
    ]);
    if (flows.residentCapitalOutflow > 0) apply("resident-capital-outflow", "U.S. residents exchange deposits for foreign claims.", [
      debit(A.foreignClaims, flows.residentCapitalOutflow), credit(A.domesticDeposits, flows.residentCapitalOutflow),
      debit(A.bankDomesticDeposits, flows.residentCapitalOutflow), credit(A.bankForeignDeposits, flows.residentCapitalOutflow),
      debit(A.foreignDeposits, flows.residentCapitalOutflow), credit(A.foreignClaimsIssued, flows.residentCapitalOutflow),
    ]);
    if (flows.repatriatedCapital > 0) apply("capital-repatriation", "U.S. residents repatriate foreign claims.", [
      debit(A.domesticDeposits, flows.repatriatedCapital), credit(A.foreignClaims, flows.repatriatedCapital),
      debit(A.bankForeignDeposits, flows.repatriatedCapital), credit(A.bankDomesticDeposits, flows.repatriatedCapital),
      debit(A.foreignClaimsIssued, flows.repatriatedCapital), credit(A.foreignDeposits, flows.repatriatedCapital),
    ]);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  const residuals = measureLedgerResiduals(ledger);
  failures.push(...checkLedgerInvariants(ledger).map((failure) => `${failure.invariant}: ${failure.message}`));
  const trialBalanceResidual =
    Math.abs(residuals.trialBalance) <= epsilon ? 0 : residuals.trialBalance;
  const instrumentResidual =
    Math.abs(residuals.instrumentMirror) <= epsilon
      ? 0
      : residuals.instrumentMirror;
  return {
    trialBalanceResidual,
    instrumentResidual,
    events: ledger.sequence,
    failures,
    passed:
      failures.length === 0 &&
      trialBalanceResidual === 0 &&
      instrumentResidual === 0,
  };
};
