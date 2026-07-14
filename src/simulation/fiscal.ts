import type {
  FiscalProjectionYear,
  ComparisonRequestV1,
} from "./contracts.js";
import type { SurplusUse, UbiFundingRule } from "../policies/schema.js";
import { MODEL_CONSTANTS } from "./modelConstants.js";

export interface FiscalState {
  readonly programDebt: number;
  readonly treasuryBalance: number;
  readonly cumulativeDebtIssued: number;
  readonly cumulativeDebtRepaid: number;
  readonly revenueHistory: readonly number[];
}

export interface FiscalYearInput {
  readonly year: number;
  readonly taxRevenue: number;
  readonly requestedProgramOutlay: number;
  readonly fundingRule: UbiFundingRule;
  readonly surplusUse: SurplusUse;
  readonly averageInterestRate?: number;
}

export interface FiscalYearTransition {
  readonly year: FiscalProjectionYear;
  readonly state: FiscalState;
}

export const EMPTY_FISCAL_STATE: FiscalState = {
  programDebt: 0,
  treasuryBalance: 0,
  cumulativeDebtIssued: 0,
  cumulativeDebtRepaid: 0,
  revenueHistory: [],
};

/**
 * Applies one explicit government budget identity:
 *
 * revenue + borrowing + opening Treasury balance
 *   = program outlay + interest + debt repayment + ending Treasury balance
 *
 * A revenue-constrained program cannot borrow or draw a prior Treasury balance.
 * Fixed and smoothed programs may use a prior balance before issuing debt. Every
 * surplus first retires debt issued by this program; the selected closure rule
 * decides what happens to any amount left over.
 */
export const resolveFiscalYear = (
  input: FiscalYearInput,
  opening: FiscalState = EMPTY_FISCAL_STATE,
): FiscalYearTransition => {
  assertFiniteNonnegative(input.taxRevenue, "Tax revenue");
  assertFiniteNonnegative(input.requestedProgramOutlay, "Requested program outlay");
  const interestRate =
    input.averageInterestRate ?? MODEL_CONSTANTS.averagePublicDebtInterestRate;
  assertFiniteNonnegative(interestRate, "Average public-debt interest rate");

  const revenueHistory = [...opening.revenueHistory, input.taxRevenue];
  const trailingRevenue = revenueHistory.slice(
    -MODEL_CONSTANTS.fiscalSmoothingWindowYears,
  );
  const smoothedRevenue =
    trailingRevenue.reduce((sum, revenue) => sum + revenue, 0) /
    Math.max(1, trailingRevenue.length);
  const scheduledProgramOutlay = scheduledOutlay(
    input.fundingRule,
    input.requestedProgramOutlay,
    input.taxRevenue,
    smoothedRevenue,
  );
  const interestExpense = opening.programDebt * interestRate;

  // Revenue-constrained means current revenue only. A Treasury balance selected
  // in prior years remains visible but is not silently converted into spending.
  const reservedTreasury =
    input.fundingRule === "revenue-constrained" ? opening.treasuryBalance : 0;
  const spendableTreasury = opening.treasuryBalance - reservedTreasury;
  const availableBeforeBorrowing = input.taxRevenue + spendableTreasury;
  const coreUses = scheduledProgramOutlay + interestExpense;
  const debtIssued = Math.max(0, coreUses - availableBeforeBorrowing);
  let unallocatedSurplus = Math.max(0, availableBeforeBorrowing - coreUses);

  const programDebtBeforeRepayment = opening.programDebt + debtIssued;
  const programDebtRepaid = Math.min(
    unallocatedSurplus,
    programDebtBeforeRepayment,
  );
  unallocatedSurplus -= programDebtRepaid;

  let externalDebtRepaid = 0;
  let additionalServices = 0;
  let rebate = 0;
  let endingTreasuryBalance = reservedTreasury;
  switch (input.surplusUse) {
    case "debt-reduction":
      externalDebtRepaid = unallocatedSurplus;
      break;
    case "additional-services":
      additionalServices = unallocatedSurplus;
      break;
    case "rebate":
      rebate = unallocatedSurplus;
      break;
    case "treasury-balance":
      endingTreasuryBalance += unallocatedSurplus;
      break;
  }

  const debtRepaid = programDebtRepaid + externalDebtRepaid;
  const programDebt = Math.max(
    0,
    programDebtBeforeRepayment - programDebtRepaid,
  );
  const programOutlay =
    scheduledProgramOutlay + additionalServices + rebate;
  const governmentOutlay = programOutlay + interestExpense;
  const cumulativeDebtIssued = opening.cumulativeDebtIssued + debtIssued;
  const cumulativeDebtRepaid = opening.cumulativeDebtRepaid + debtRepaid;
  const netPublicDebtChange = cumulativeDebtIssued - cumulativeDebtRepaid;
  const sources =
    input.taxRevenue + debtIssued + opening.treasuryBalance;
  const uses = governmentOutlay + debtRepaid + endingTreasuryBalance;
  const budgetIdentityResidual = sources - uses;

  const year: FiscalProjectionYear = {
    year: input.year,
    taxRevenue: input.taxRevenue,
    requestedProgramOutlay: input.requestedProgramOutlay,
    scheduledProgramOutlay,
    additionalServices,
    rebate,
    programOutlay,
    interestExpense,
    governmentOutlay,
    debtIssued,
    debtRepaid,
    // Prospective annual savings at the same documented average rate. Realized
    // program-debt savings appear as lower interestExpense in later years.
    interestSavings: debtRepaid * interestRate,
    programDebt,
    treasuryBalance: endingTreasuryBalance,
    netPublicDebtChange,
    budgetIdentityResidual,
  };
  return {
    year,
    state: {
      programDebt,
      treasuryBalance: endingTreasuryBalance,
      cumulativeDebtIssued,
      cumulativeDebtRepaid,
      revenueHistory,
    },
  };
};

export const projectFiscalPath = (input: {
  readonly taxRevenues: readonly number[];
  readonly requestedProgramOutlays: readonly number[];
  readonly fundingRule: UbiFundingRule;
  readonly surplusUse: SurplusUse;
  readonly averageInterestRate?: number;
}): readonly FiscalProjectionYear[] => {
  if (input.taxRevenues.length !== input.requestedProgramOutlays.length) {
    throw new Error("Fiscal revenue and requested-outlay paths must have equal length.");
  }
  let state = EMPTY_FISCAL_STATE;
  return input.taxRevenues.map((taxRevenue, index) => {
    const transition = resolveFiscalYear(
      {
        year: index + 1,
        taxRevenue,
        requestedProgramOutlay: input.requestedProgramOutlays[index] ?? 0,
        fundingRule: input.fundingRule,
        surplusUse: input.surplusUse,
        ...(input.averageInterestRate === undefined
          ? {}
          : { averageInterestRate: input.averageInterestRate }),
      },
      state,
    );
    state = transition.state;
    return transition.year;
  });
};

export const normalizedSurplusUse = (
  request: ComparisonRequestV1,
): SurplusUse => request.ubi.surplusUse ?? "debt-reduction";

const scheduledOutlay = (
  fundingRule: UbiFundingRule,
  requested: number,
  currentRevenue: number,
  smoothedRevenue: number,
): number => {
  switch (fundingRule) {
    case "fixed":
      return requested;
    case "revenue-constrained":
      return Math.min(requested, currentRevenue);
    case "smoothed":
      return Math.min(requested, smoothedRevenue);
  }
};

const assertFiniteNonnegative = (value: number, label: string): void => {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be finite and nonnegative.`);
  }
};
