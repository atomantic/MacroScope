import { describe, expect, it } from "vitest";
import {
  assertLedgerInvariants,
  createOpeningLedger,
  distributeUbi,
  householdAccounts,
  originateCollateralizedLoan,
  payCollateralizedLoanInterest,
  payTaxFromDeposits,
  repayCollateralizedLoan,
  SYSTEM_ACCOUNTS,
  transferPublicEquityForDeposits,
} from "../src/index.js";

const openingEconomy = () =>
  createOpeningLedger({
    bankReserves: 200,
    households: [
      {
        id: "household:taxpayer",
        deposits: 100,
        collateralizedLoans: 0,
        publicEquity: 500,
      },
      {
        id: "household:buyer",
        deposits: 100,
        collateralizedLoans: 0,
        publicEquity: 100,
      },
    ],
  });

describe("accounting kernel", () => {
  it("rejects an unbalanced journal event atomically", () => {
    const ledger = openingEconomy();
    const before = ledger.snapshot();
    expect(() =>
      ledger.apply({
        id: "bad-event",
        tick: 0,
        layer: "transaction",
        cause: "shock",
        description: "Invalid mutation",
        postings: [
          { accountId: SYSTEM_ACCOUNTS.bankLoans, side: "debit", amount: 10 },
          { accountId: SYSTEM_ACCOUNTS.bankDeposits, side: "credit", amount: 9 },
        ],
      }),
    ).toThrow(/Unbalanced journal event/);
    expect(ledger.snapshot()).toEqual(before);
  });

  it("rejects an event that only balances by shifting a residual between sectors", () => {
    const ledger = openingEconomy();
    expect(() =>
      ledger.apply({
        id: "cross-sector-residual",
        tick: 0,
        layer: "transaction",
        cause: "shock",
        description: "Invalid cross-sector entry",
        postings: [
          { accountId: SYSTEM_ACCOUNTS.bankLoans, side: "debit", amount: 10 },
          {
            accountId: householdAccounts("household:taxpayer").openingEquity,
            side: "credit",
            amount: 10,
          },
        ],
      }),
    ).toThrow(/not balanced for/);
    expect(ledger.sequence).toBe(0);
  });

  it("cash-funded tax and equal UBI leave aggregate deposits unchanged", () => {
    const ledger = openingEconomy();
    const openingDeposits = ledger.balance(SYSTEM_ACCOUNTS.bankDeposits);
    const openingLoans = ledger.balance(SYSTEM_ACCOUNTS.bankLoans);

    payTaxFromDeposits(ledger, "household:taxpayer", 20, {
      tick: 1,
      eventId: "cash-tax",
    });
    distributeUbi(ledger, { "household:taxpayer": 10, "household:buyer": 10 }, {
      tick: 1,
      eventId: "cash-ubi",
    });

    expect(ledger.balance(SYSTEM_ACCOUNTS.bankDeposits)).toBe(openingDeposits);
    expect(ledger.balance(SYSTEM_ACCOUNTS.bankLoans)).toBe(openingLoans);
    assertLedgerInvariants(ledger);
  });

  it("borrow-funded tax and equal UBI leave deposits and loans higher", () => {
    const ledger = openingEconomy();
    const openingDeposits = ledger.balance(SYSTEM_ACCOUNTS.bankDeposits);
    const openingLoans = ledger.balance(SYSTEM_ACCOUNTS.bankLoans);

    originateCollateralizedLoan(ledger, "household:taxpayer", 20, {
      tick: 1,
      eventId: "tax-loan",
    });
    payTaxFromDeposits(ledger, "household:taxpayer", 20, {
      tick: 1,
      eventId: "borrow-tax",
    });
    distributeUbi(ledger, { "household:taxpayer": 10, "household:buyer": 10 }, {
      tick: 1,
      eventId: "borrow-ubi",
    });

    expect(ledger.balance(SYSTEM_ACCOUNTS.bankDeposits)).toBe(openingDeposits + 20);
    expect(ledger.balance(SYSTEM_ACCOUNTS.bankLoans)).toBe(openingLoans + 20);
    assertLedgerInvariants(ledger);
  });

  it("an asset sale using existing deposits changes ownership, not deposits", () => {
    const ledger = openingEconomy();
    const taxpayer = householdAccounts("household:taxpayer");
    const buyer = householdAccounts("household:buyer");
    const openingDeposits = ledger.balance(SYSTEM_ACCOUNTS.bankDeposits);

    transferPublicEquityForDeposits(
      ledger,
      "household:taxpayer",
      "household:buyer",
      20,
      { tick: 1, eventId: "equity-sale" },
    );

    expect(ledger.balance(SYSTEM_ACCOUNTS.bankDeposits)).toBe(openingDeposits);
    expect(ledger.balance(taxpayer.publicEquity)).toBe(480);
    expect(ledger.balance(buyer.publicEquity)).toBe(120);
    expect(ledger.balance(taxpayer.deposits)).toBe(120);
    expect(ledger.balance(buyer.deposits)).toBe(80);
    assertLedgerInvariants(ledger);
  });

  it("loan repayment destroys equal amounts of loans and deposits", () => {
    const ledger = openingEconomy();
    originateCollateralizedLoan(ledger, "household:taxpayer", 20, {
      tick: 1,
      eventId: "loan",
    });
    const depositsBeforeRepayment = ledger.balance(SYSTEM_ACCOUNTS.bankDeposits);
    const loansBeforeRepayment = ledger.balance(SYSTEM_ACCOUNTS.bankLoans);

    repayCollateralizedLoan(ledger, "household:taxpayer", 20, {
      tick: 2,
      eventId: "repayment",
    });

    expect(ledger.balance(SYSTEM_ACCOUNTS.bankDeposits)).toBe(depositsBeforeRepayment - 20);
    expect(ledger.balance(SYSTEM_ACCOUNTS.bankLoans)).toBe(loansBeforeRepayment - 20);
    assertLedgerInvariants(ledger);
  });

  it("reconciles loan origination, retained interest, and principal repayment", () => {
    const ledger = openingEconomy();
    const household = householdAccounts("household:taxpayer");

    originateCollateralizedLoan(ledger, "household:taxpayer", 100, {
      tick: 1,
      eventId: "loan-origination",
    });
    payCollateralizedLoanInterest(ledger, "household:taxpayer", 10, {
      tick: 2,
      eventId: "retained-interest",
    });
    repayCollateralizedLoan(ledger, "household:taxpayer", 40, {
      tick: 3,
      eventId: "principal-repayment",
    });

    expect(ledger.balance(household.deposits)).toBe(150);
    expect(ledger.balance(household.loans)).toBe(60);
    expect(ledger.balance(SYSTEM_ACCOUNTS.bankDeposits)).toBe(250);
    expect(ledger.balance(SYSTEM_ACCOUNTS.bankLoans)).toBe(60);
    expect(ledger.balance(SYSTEM_ACCOUNTS.bankInterestIncome)).toBe(10);

    const bankAssets =
      ledger.balance(SYSTEM_ACCOUNTS.bankLoans) +
      ledger.balance(SYSTEM_ACCOUNTS.bankReserves);
    const bankClaimsAndEarnedEquity =
      ledger.balance(SYSTEM_ACCOUNTS.bankDeposits) +
      ledger.balance(SYSTEM_ACCOUNTS.bankEquity) +
      ledger.balance(SYSTEM_ACCOUNTS.bankInterestIncome);
    expect(bankAssets).toBe(260);
    expect(bankClaimsAndEarnedEquity).toBe(bankAssets);
    assertLedgerInvariants(ledger);
  });
});
