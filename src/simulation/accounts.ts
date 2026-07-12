import { Ledger } from "../core/ledger.js";
import type { AccountDefinition } from "../core/types.js";

export const SYSTEM = {
  bank: "bank:commercial",
  government: "government:treasury",
  centralBank: "central-bank:reserve",
  firms: "firms:aggregate",
} as const;

export const SYSTEM_ACCOUNTS = {
  bankLoans: "bank:loans",
  bankReserves: "bank:reserves",
  bankDeposits: "bank:deposits",
  bankEquity: "bank:opening-equity",
  treasury: "government:treasury-account",
  taxIncome: "government:tax-income",
  ubiExpense: "government:ubi-expense",
  centralBankAssets: "central-bank:government-securities",
  reserveLiability: "central-bank:reserve-liability",
  treasuryLiability: "central-bank:treasury-liability",
  productiveCapital: "firms:productive-capital",
  issuedEquity: "firms:issued-equity",
} as const;

export const householdAccounts = (householdId: string) => ({
  deposits: `${householdId}:deposits`,
  loans: `${householdId}:collateralized-loans`,
  publicEquity: `${householdId}:public-equity`,
  openingEquity: `${householdId}:opening-equity`,
  taxExpense: `${householdId}:tax-expense`,
  ubiIncome: `${householdId}:ubi-income`,
});

export interface OpeningHousehold {
  readonly id: string;
  readonly label?: string;
  readonly deposits: number;
  readonly collateralizedLoans: number;
  readonly publicEquity: number;
}

export interface OpeningEconomy {
  readonly households: readonly OpeningHousehold[];
  readonly bankReserves?: number;
  readonly treasuryBalance?: number;
}

export const createOpeningLedger = (economy: OpeningEconomy): Ledger => {
  const ledger = new Ledger();
  ledger.addEntity({ id: SYSTEM.bank, kind: "bank", label: "Commercial bank" });
  ledger.addEntity({
    id: SYSTEM.government,
    kind: "government",
    label: "Federal government",
  });
  ledger.addEntity({
    id: SYSTEM.centralBank,
    kind: "central-bank",
    label: "Central bank",
  });
  ledger.addEntity({ id: SYSTEM.firms, kind: "firm", label: "Aggregate firms" });

  const totalDeposits = sum(economy.households, (household) => household.deposits);
  const totalLoans = sum(economy.households, (household) => household.collateralizedLoans);
  const totalPublicEquity = sum(economy.households, (household) => household.publicEquity);
  const treasuryBalance = economy.treasuryBalance ?? 0;
  const minimumReserves = Math.max(0, totalDeposits - totalLoans);
  const bankReserves = economy.bankReserves ?? minimumReserves;
  const bankOpeningEquity = totalLoans + bankReserves - totalDeposits;
  if (bankOpeningEquity < -ledger.epsilon) {
    throw new Error("Opening bank assets must cover deposits.");
  }

  add(ledger, {
    id: SYSTEM_ACCOUNTS.bankLoans,
    ownerId: SYSTEM.bank,
    name: "Collateralized loans",
    class: "asset",
    instrument: "collateralized-loan",
    claimSide: "holder",
  }, totalLoans);
  add(ledger, {
    id: SYSTEM_ACCOUNTS.bankReserves,
    ownerId: SYSTEM.bank,
    name: "Central-bank reserves",
    class: "asset",
    instrument: "central-bank-reserve",
    claimSide: "holder",
  }, bankReserves);
  add(ledger, {
    id: SYSTEM_ACCOUNTS.bankDeposits,
    ownerId: SYSTEM.bank,
    name: "Customer deposits",
    class: "liability",
    instrument: "deposit",
    claimSide: "issuer",
  }, totalDeposits);
  add(ledger, {
    id: SYSTEM_ACCOUNTS.bankEquity,
    ownerId: SYSTEM.bank,
    name: "Opening bank equity",
    class: "equity",
  }, bankOpeningEquity);

  add(ledger, {
    id: SYSTEM_ACCOUNTS.treasury,
    ownerId: SYSTEM.government,
    name: "Treasury account",
    class: "asset",
    instrument: "treasury-account",
    claimSide: "holder",
  }, treasuryBalance);
  add(ledger, {
    id: SYSTEM_ACCOUNTS.taxIncome,
    ownerId: SYSTEM.government,
    name: "Tax income",
    class: "income",
    reconciliation: { flow: "tax", side: "destination" },
  });
  add(ledger, {
    id: SYSTEM_ACCOUNTS.ubiExpense,
    ownerId: SYSTEM.government,
    name: "UBI expense",
    class: "expense",
    reconciliation: { flow: "ubi", side: "source" },
  });
  add(ledger, {
    id: "government:opening-equity",
    ownerId: SYSTEM.government,
    name: "Opening fiscal balance",
    class: "equity",
  }, treasuryBalance);

  add(ledger, {
    id: SYSTEM_ACCOUNTS.centralBankAssets,
    ownerId: SYSTEM.centralBank,
    name: "Government securities",
    class: "asset",
    instrument: "government-security",
    claimSide: "holder",
  }, bankReserves + treasuryBalance);
  add(ledger, {
    id: SYSTEM_ACCOUNTS.reserveLiability,
    ownerId: SYSTEM.centralBank,
    name: "Bank reserve account",
    class: "liability",
    instrument: "central-bank-reserve",
    claimSide: "issuer",
  }, bankReserves);
  add(ledger, {
    id: SYSTEM_ACCOUNTS.treasuryLiability,
    ownerId: SYSTEM.centralBank,
    name: "Treasury account liability",
    class: "liability",
    instrument: "treasury-account",
    claimSide: "issuer",
  }, treasuryBalance);

  add(ledger, {
    id: SYSTEM_ACCOUNTS.productiveCapital,
    ownerId: SYSTEM.firms,
    name: "Productive capital",
    class: "asset",
    instrument: "productive-capital",
    claimSide: "holder",
  }, totalPublicEquity);
  add(ledger, {
    id: SYSTEM_ACCOUNTS.issuedEquity,
    ownerId: SYSTEM.firms,
    name: "Public equity issued",
    class: "equity",
    instrument: "public-equity",
    claimSide: "issuer",
  }, totalPublicEquity);

  for (const household of economy.households) {
    ledger.addEntity({
      id: household.id,
      kind: "household",
      label: household.label ?? household.id,
    });
    const accounts = householdAccounts(household.id);
    add(ledger, {
      id: accounts.deposits,
      ownerId: household.id,
      name: "Bank deposits",
      class: "asset",
      instrument: "deposit",
      claimSide: "holder",
      counterpartyId: SYSTEM.bank,
    }, household.deposits);
    add(ledger, {
      id: accounts.loans,
      ownerId: household.id,
      name: "Collateralized loans",
      class: "liability",
      instrument: "collateralized-loan",
      claimSide: "issuer",
      counterpartyId: SYSTEM.bank,
    }, household.collateralizedLoans);
    add(ledger, {
      id: accounts.publicEquity,
      ownerId: household.id,
      name: "Public equity",
      class: "asset",
      instrument: "public-equity",
      claimSide: "holder",
      counterpartyId: SYSTEM.firms,
    }, household.publicEquity);
    add(ledger, {
      id: accounts.openingEquity,
      ownerId: household.id,
      name: "Opening household net worth",
      class: "equity",
      allowNegative: true,
    }, household.deposits + household.publicEquity - household.collateralizedLoans);
    add(ledger, {
      id: accounts.taxExpense,
      ownerId: household.id,
      name: "Wealth-tax expense",
      class: "expense",
      reconciliation: { flow: "tax", side: "source" },
    });
    add(ledger, {
      id: accounts.ubiIncome,
      ownerId: household.id,
      name: "UBI income",
      class: "income",
      reconciliation: { flow: "ubi", side: "destination" },
    });
  }

  return ledger;
};

const add = (ledger: Ledger, account: AccountDefinition, balance = 0): void =>
  ledger.addAccount(account, balance);

const sum = <T>(values: readonly T[], select: (value: T) => number): number =>
  values.reduce((total, value) => total + select(value), 0);
