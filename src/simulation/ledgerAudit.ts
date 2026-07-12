import {
  checkLedgerInvariants,
  measureLedgerResiduals,
} from "../core/invariants.js";
import type { Ledger } from "../core/ledger.js";
import {
  createOpeningLedger,
  householdAccounts,
  SYSTEM_ACCOUNTS,
} from "./accounts.js";
import type { StrategyOutcome } from "./contracts.js";
import {
  distributeUbi,
  originateCollateralizedLoan,
  payGovernmentOperations,
  payTaxFromDeposits,
  repayCollateralizedLoan,
} from "./settlement.js";

/**
 * Aggregate sector-level flows for one payment strategy. Intra-household
 * trades (equity and housing sales between households) net to zero on the
 * household sector's deposit and book positions, so only their bank-visible
 * legs appear here: sale proceeds that settle tax and forced loan repayments.
 */
export interface StrategyFlowAggregates {
  readonly openingDeposits: number;
  readonly openingCollateralizedLoans: number;
  readonly openingPublicEquity: number;
  readonly newLoans: number;
  readonly taxCollected: number;
  readonly ubiReceived: number;
  /** Public services, administration, and leakage paid to the firm sector. */
  readonly otherGovernmentOutlays: number;
  readonly forcedLoanRepayments: number;
}

export interface LedgerAuditResult {
  readonly householdDepositsChange: number;
  readonly bankDepositsChange: number;
  readonly trialBalanceResidual: number;
  readonly instrumentResidual: number;
  readonly events: number;
  readonly failures: readonly string[];
}

export type StrategyAccounting = StrategyOutcome["accounting"];

export interface StrategyAccountingInputs {
  readonly flows: StrategyFlowAggregates;
  /** Independently computed sum of per-household (depositsAfter - deposits). */
  readonly perHouseholdDepositsChange: number;
  readonly taxAssessed: number;
  readonly taxDeferred: number;
  readonly equityQuantityResidual: number;
  readonly housingQuantityResidual: number;
  readonly tolerance: number;
}

const HOUSEHOLD_SECTOR = "household:sector";

/**
 * Replays a strategy's aggregate flows through the double-entry ledger
 * kernel. Every event must balance per entity and per instrument, accounts
 * may not overdraw, and the closing books must satisfy the economy-wide
 * trial balance — so the returned balances are derived by a code path that
 * is independent of the scenario runner's flow arithmetic.
 */
export const auditStrategyFlows = (
  flows: StrategyFlowAggregates,
): LedgerAuditResult => {
  const governmentOutlays = flows.ubiReceived + flows.otherGovernmentOutlays;
  const scale =
    Math.abs(flows.openingDeposits) +
    Math.abs(flows.openingCollateralizedLoans) +
    Math.abs(flows.openingPublicEquity) +
    Math.abs(flows.newLoans) +
    Math.abs(flows.taxCollected) +
    Math.abs(governmentOutlays) +
    Math.abs(flows.forcedLoanRepayments);
  const epsilon = Math.max(1e-6, scale * 1e-12);
  const failures: string[] = [];
  let ledger: Ledger | undefined;

  // The kernel reports broken conservation by throwing (unbalanced event,
  // sector residual, instrument mismatch, overdraw). The audit must surface
  // that as a failed accounting check instead of crashing the scenario API,
  // so this is one of the rare places a try/catch is required.
  try {
    ledger = createOpeningLedger(
      {
        households: [
          {
            id: HOUSEHOLD_SECTOR,
            deposits: flows.openingDeposits,
            collateralizedLoans: flows.openingCollateralizedLoans,
            publicEquity: flows.openingPublicEquity,
          },
        ],
        bankReserves: Math.max(
          flows.openingDeposits - flows.openingCollateralizedLoans,
          flows.taxCollected,
        ),
        treasuryBalance: governmentOutlays,
      },
      epsilon,
    );
    if (flows.newLoans > 0) {
      originateCollateralizedLoan(ledger, HOUSEHOLD_SECTOR, flows.newLoans, {
        tick: 1,
        eventId: "audit-loan-origination",
      });
    }
    if (flows.ubiReceived > 0) {
      distributeUbi(
        ledger,
        { [HOUSEHOLD_SECTOR]: flows.ubiReceived },
        { tick: 1, eventId: "audit-ubi" },
      );
    }
    if (flows.otherGovernmentOutlays > 0) {
      payGovernmentOperations(ledger, flows.otherGovernmentOutlays, {
        tick: 1,
        eventId: "audit-government-operations",
      });
    }
    if (flows.taxCollected > 0) {
      payTaxFromDeposits(ledger, HOUSEHOLD_SECTOR, flows.taxCollected, {
        tick: 1,
        eventId: "audit-tax-settlement",
      });
    }
    if (flows.forcedLoanRepayments > 0) {
      repayCollateralizedLoan(ledger, HOUSEHOLD_SECTOR, flows.forcedLoanRepayments, {
        tick: 1,
        eventId: "audit-forced-repayment",
      });
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  if (!ledger) {
    return {
      householdDepositsChange: 0,
      bankDepositsChange: 0,
      trialBalanceResidual: 0,
      instrumentResidual: 0,
      events: 0,
      failures,
    };
  }

  const residuals = measureLedgerResiduals(ledger);
  failures.push(
    ...checkLedgerInvariants(ledger).map(
      (failure) => `${failure.invariant}: ${failure.message}`,
    ),
  );
  return {
    householdDepositsChange:
      ledger.balance(householdAccounts(HOUSEHOLD_SECTOR).deposits) -
      flows.openingDeposits,
    bankDepositsChange:
      ledger.balance(SYSTEM_ACCOUNTS.bankDeposits) - flows.openingDeposits,
    trialBalanceResidual: residuals.trialBalance,
    instrumentResidual: residuals.instrumentMirror,
    events: ledger.sequence,
    failures,
  };
};

/**
 * Builds the accounting block for one strategy from genuinely independent
 * cross-checks:
 * - depositsIdentityResidual compares the per-household deposit deltas with
 *   the ledger's household-sector deposit balance after replaying the
 *   aggregate flows.
 * - taxFundingResidual checks that assessed tax splits exactly into
 *   collected and deferred amounts across the funding allocator.
 * - the ledger trial-balance and instrument-mirror residuals come from the
 *   double-entry kernel itself.
 */
export const computeStrategyAccounting = (
  inputs: StrategyAccountingInputs,
): StrategyAccounting => {
  const audit = auditStrategyFlows(inputs.flows);
  const depositsIdentityResidual =
    inputs.perHouseholdDepositsChange - audit.householdDepositsChange;
  const taxFundingResidual =
    inputs.taxAssessed - inputs.flows.taxCollected - inputs.taxDeferred;
  const passed =
    Math.abs(depositsIdentityResidual) <= inputs.tolerance &&
    Math.abs(taxFundingResidual) <= inputs.tolerance &&
    Math.abs(inputs.equityQuantityResidual) <= inputs.tolerance &&
    Math.abs(inputs.housingQuantityResidual) <= inputs.tolerance &&
    Math.abs(audit.trialBalanceResidual) <= inputs.tolerance &&
    Math.abs(audit.instrumentResidual) <= inputs.tolerance &&
    audit.failures.length === 0;
  return {
    depositsIdentityResidual,
    taxFundingResidual,
    equityQuantityResidual: inputs.equityQuantityResidual,
    housingQuantityResidual: inputs.housingQuantityResidual,
    ledgerTrialBalanceResidual: audit.trialBalanceResidual,
    ledgerInstrumentResidual: audit.instrumentResidual,
    ledgerEvents: audit.events,
    ledgerFailures: audit.failures,
    passed,
  };
};
