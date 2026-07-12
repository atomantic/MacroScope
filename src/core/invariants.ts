import type { Ledger } from "./ledger.js";
import type { AccountSnapshot, InvariantFailure, Instrument } from "./types.js";

const debitNormal = (account: AccountSnapshot): boolean =>
  account.class === "asset" || account.class === "expense";

const signedTrialBalance = (account: AccountSnapshot): number =>
  debitNormal(account) ? account.balance : -account.balance;

const residualFailure = (
  invariant: string,
  message: string,
  residual: number,
  epsilon: number,
): InvariantFailure[] =>
  Math.abs(residual) <= epsilon ? [] : [{ invariant, message, residual }];

export interface LedgerResiduals {
  readonly trialBalance: number;
  readonly instrumentMirror: number;
}

const MIRRORLESS_INSTRUMENTS: readonly Instrument[] = [
  "productive-capital",
  "government-security",
];

export const measureLedgerResiduals = (ledger: Ledger): LedgerResiduals => {
  const accounts = ledger.accounts();
  const trialBalance = accounts.reduce(
    (total, account) => total + signedTrialBalance(account),
    0,
  );
  const instruments = new Set(
    accounts.flatMap((account) => (account.instrument ? [account.instrument] : [])),
  );
  let instrumentMirror = 0;
  for (const instrument of instruments) {
    if (MIRRORLESS_INSTRUMENTS.includes(instrument)) continue;
    const residual =
      sumInstrument(accounts, instrument, "holder") -
      sumInstrument(accounts, instrument, "issuer");
    if (Math.abs(residual) > Math.abs(instrumentMirror)) instrumentMirror = residual;
  }
  return { trialBalance, instrumentMirror };
};

export const checkLedgerInvariants = (ledger: Ledger): readonly InvariantFailure[] => {
  const accounts = ledger.accounts();
  const failures: InvariantFailure[] = [];

  const economyResidual = accounts.reduce(
    (total, account) => total + signedTrialBalance(account),
    0,
  );
  failures.push(
    ...residualFailure(
      "economy-trial-balance",
      "The economy-wide debit and credit balances differ.",
      economyResidual,
      ledger.epsilon,
    ),
  );

  for (const entity of ledger.entities()) {
    const entityResidual = accounts
      .filter((account) => account.ownerId === entity.id)
      .reduce((total, account) => total + signedTrialBalance(account), 0);
    failures.push(
      ...residualFailure(
        "entity-trial-balance",
        `Accounting identity failed for ${entity.id}.`,
        entityResidual,
        ledger.epsilon,
      ),
    );
  }

  const instruments = new Set(
    accounts.flatMap((account) => (account.instrument ? [account.instrument] : [])),
  );
  for (const instrument of instruments) {
    if (MIRRORLESS_INSTRUMENTS.includes(instrument)) {
      continue;
    }
    const holderBalance = sumInstrument(accounts, instrument, "holder");
    const issuerBalance = sumInstrument(accounts, instrument, "issuer");
    failures.push(
      ...residualFailure(
        "instrument-mirror",
        `Holder and issuer balances differ for ${instrument}.`,
        holderBalance - issuerBalance,
        ledger.epsilon,
      ),
    );
  }

  for (const account of accounts) {
    if (!account.allowNegative && account.balance < -ledger.epsilon) {
      failures.push({
        invariant: "nonnegative-account",
        message: `${account.id} has a negative balance.`,
        residual: account.balance,
      });
    }
  }

  for (const flow of ["tax", "ubi"] as const) {
    const source = accounts
      .filter(
        (account) =>
          account.reconciliation?.flow === flow &&
          account.reconciliation.side === "source",
      )
      .reduce((total, account) => total + account.balance, 0);
    const destination = accounts
      .filter(
        (account) =>
          account.reconciliation?.flow === flow &&
          account.reconciliation.side === "destination",
      )
      .reduce((total, account) => total + account.balance, 0);
    failures.push(
      ...residualFailure(
        "flow-reconciliation",
        `${flow} source and destination balances differ.`,
        source - destination,
        ledger.epsilon,
      ),
    );
  }

  return failures;
};

const sumInstrument = (
  accounts: readonly AccountSnapshot[],
  instrument: Instrument,
  claimSide: "holder" | "issuer",
): number =>
  accounts
    .filter(
      (account) => account.instrument === instrument && account.claimSide === claimSide,
    )
    .reduce((total, account) => total + account.balance, 0);

export const assertLedgerInvariants = (ledger: Ledger): void => {
  const failures = checkLedgerInvariants(ledger);
  if (failures.length > 0) {
    throw new Error(
      `Ledger invariants failed:\n${failures
        .map((failure) => `- ${failure.invariant}: ${failure.message}`)
        .join("\n")}`,
    );
  }
};
