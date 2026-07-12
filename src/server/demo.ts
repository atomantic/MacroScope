import { assertLedgerInvariants } from "../core/invariants.js";
import { createOpeningLedger, SYSTEM_ACCOUNTS } from "../simulation/accounts.js";
import {
  distributeUbi,
  originateCollateralizedLoan,
  payTaxFromDeposits,
} from "../simulation/settlement.js";

export interface DemoMetrics {
  readonly deposits: number;
  readonly loans: number;
  readonly treasuryBalance: number;
  readonly events: number;
}

export interface DemoComparison {
  readonly taxAmount: number;
  readonly cashFunded: DemoMetrics;
  readonly borrowFunded: DemoMetrics;
  readonly delta: {
    readonly borrowVsCash: {
      readonly deposits: number;
      readonly loans: number;
    };
  };
}

const TAX_AMOUNT = 20;

export const createDemoComparison = (): DemoComparison => {
  const cashFunded = runPath(false);
  const borrowFunded = runPath(true);
  return {
    taxAmount: TAX_AMOUNT,
    cashFunded,
    borrowFunded,
    delta: {
      borrowVsCash: {
        deposits: borrowFunded.deposits - cashFunded.deposits,
        loans: borrowFunded.loans - cashFunded.loans,
      },
    },
  };
};

const runPath = (borrow: boolean): DemoMetrics => {
  const ledger = createOpeningLedger({
    bankReserves: 200,
    households: [
      {
        id: "household:taxpayer",
        deposits: 100,
        collateralizedLoans: 0,
        publicEquity: 500,
      },
      {
        id: "household:recipient",
        deposits: 100,
        collateralizedLoans: 0,
        publicEquity: 100,
      },
    ],
  });

  if (borrow) {
    originateCollateralizedLoan(ledger, "household:taxpayer", TAX_AMOUNT, {
      tick: 1,
      eventId: "demo-loan",
    });
  }
  payTaxFromDeposits(ledger, "household:taxpayer", TAX_AMOUNT, {
    tick: 1,
    eventId: "demo-tax",
  });
  distributeUbi(
    ledger,
    { "household:taxpayer": TAX_AMOUNT / 2, "household:recipient": TAX_AMOUNT / 2 },
    { tick: 1, eventId: "demo-ubi" },
  );
  assertLedgerInvariants(ledger);

  return {
    deposits: ledger.balance(SYSTEM_ACCOUNTS.bankDeposits),
    loans: ledger.balance(SYSTEM_ACCOUNTS.bankLoans),
    treasuryBalance: ledger.balance(SYSTEM_ACCOUNTS.treasury),
    events: ledger.sequence,
  };
};
