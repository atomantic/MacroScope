import { describe, expect, it } from "vitest";
import {
  auditStrategyFlows,
  computeStrategyAccounting,
  type StrategyAccountingInputs,
  type StrategyFlowAggregates,
} from "../src/index.js";

const consistentFlows = (): StrategyFlowAggregates => ({
  openingDeposits: 1_000_000,
  openingCollateralizedLoans: 100_000,
  openingPublicEquity: 5_000_000,
  newLoans: 40_000,
  taxCollected: 90_000,
  ubiReceived: 70_000,
  otherGovernmentOutlays: 20_000,
  forcedLoanRepayments: 5_000,
});

const consistentInputs = (): StrategyAccountingInputs => {
  const flows = consistentFlows();
  return {
    flows,
    // Matches the flow identity: newLoans - tax + ubi - forced repayments.
    perHouseholdDepositsChange:
      flows.newLoans -
      flows.taxCollected +
      flows.ubiReceived -
      flows.forcedLoanRepayments,
    // Bank view adds the operations spending parked in firm deposits.
    bankDepositsChange:
      flows.newLoans -
      flows.taxCollected +
      flows.ubiReceived +
      flows.otherGovernmentOutlays -
      flows.forcedLoanRepayments,
    taxAssessed: 100_000,
    taxDeferred: 10_000,
    equityQuantityResidual: 0,
    housingQuantityResidual: 0,
    tolerance: 0.01,
  };
};

describe("scenario ledger audit", () => {
  it("replays consistent aggregate flows without failures", () => {
    const flows = consistentFlows();
    const audit = auditStrategyFlows(flows);
    expect(audit.failures).toEqual([]);
    expect(audit.replayComplete).toBe(true);
    expect(audit.events).toBe(5);
    expect(audit.householdDepositsChange).toBeCloseTo(
      flows.newLoans - flows.taxCollected + flows.ubiReceived - flows.forcedLoanRepayments,
      6,
    );
    expect(audit.bankDepositsChange).toBeCloseTo(
      flows.newLoans -
        flows.taxCollected +
        flows.ubiReceived +
        flows.otherGovernmentOutlays -
        flows.forcedLoanRepayments,
      6,
    );
    expect(Math.abs(audit.trialBalanceResidual)).toBeLessThan(1e-6);
    expect(Math.abs(audit.instrumentResidual)).toBeLessThan(1e-6);
  });

  it("passes accounting for internally consistent inputs", () => {
    const accounting = computeStrategyAccounting(consistentInputs());
    expect(accounting.passed).toBe(true);
    expect(Math.abs(accounting.depositsIdentityResidual)).toBeLessThan(0.01);
    expect(Math.abs(accounting.taxFundingResidual)).toBeLessThan(0.01);
    expect(accounting.ledgerFailures).toEqual([]);
  });

  it("mutation: corrupting the UBI flow makes the deposits residual nonzero", () => {
    const inputs = consistentInputs();
    const corrupted: StrategyAccountingInputs = {
      ...inputs,
      flows: { ...inputs.flows, ubiReceived: inputs.flows.ubiReceived + 25_000 },
    };
    const accounting = computeStrategyAccounting(corrupted);
    expect(Math.abs(accounting.depositsIdentityResidual)).toBeCloseTo(25_000, 6);
    expect(accounting.passed).toBe(false);
  });

  it("mutation: dropping forced repayments from the flows is detected", () => {
    const inputs = consistentInputs();
    const corrupted: StrategyAccountingInputs = {
      ...inputs,
      flows: { ...inputs.flows, forcedLoanRepayments: 0 },
    };
    const accounting = computeStrategyAccounting(corrupted);
    expect(Math.abs(accounting.depositsIdentityResidual)).toBeCloseTo(
      inputs.flows.forcedLoanRepayments,
      6,
    );
    expect(accounting.passed).toBe(false);
  });

  it("mutation: a corrupted bank-deposits flow identity is detected", () => {
    const inputs = consistentInputs();
    const corrupted: StrategyAccountingInputs = {
      ...inputs,
      // Simulates a regression that drops forced repayments from the formula.
      bankDepositsChange: inputs.bankDepositsChange + inputs.flows.forcedLoanRepayments,
    };
    const accounting = computeStrategyAccounting(corrupted);
    expect(Math.abs(accounting.bankDepositsIdentityResidual)).toBeCloseTo(
      inputs.flows.forcedLoanRepayments,
      6,
    );
    expect(accounting.passed).toBe(false);
  });

  it("mutation: a funding allocator that loses money fails the tax check", () => {
    const inputs = consistentInputs();
    const corrupted: StrategyAccountingInputs = {
      ...inputs,
      // Assessed tax no longer splits into collected + deferred.
      taxDeferred: inputs.taxDeferred - 7_500,
    };
    const accounting = computeStrategyAccounting(corrupted);
    expect(Math.abs(accounting.taxFundingResidual)).toBeCloseTo(7_500, 6);
    expect(accounting.passed).toBe(false);
  });

  it("deliberately breaking conservation reports accounting.passed === false", () => {
    const inputs = consistentInputs();
    const broken: StrategyAccountingInputs = {
      ...inputs,
      // Claim households ended with more deposits than the settled flows create.
      perHouseholdDepositsChange: inputs.perHouseholdDepositsChange + 1_000,
    };
    const accounting = computeStrategyAccounting(broken);
    expect(accounting.passed).toBe(false);
    expect(Math.abs(accounting.depositsIdentityResidual)).toBeCloseTo(1_000, 6);
  });

  it("reports a settlement failure when tax exceeds available household deposits", () => {
    const flows: StrategyFlowAggregates = {
      ...consistentFlows(),
      taxCollected: 2_000_000,
    };
    const audit = auditStrategyFlows(flows);
    expect(audit.failures.length).toBeGreaterThan(0);
    expect(audit.replayComplete).toBe(false);
    expect(audit.failures.some((failure) => failure.includes("overdraw"))).toBe(true);
    const accounting = computeStrategyAccounting({
      ...consistentInputs(),
      flows,
    });
    expect(accounting.passed).toBe(false);
  });
});
