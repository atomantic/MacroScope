import { inflationFromStress } from "./projection.js";
import type { DataSource } from "./usBaseline.js";

/**
 * Historical validation of the inflation kernel against the 2020–2023 U.S.
 * episode.
 *
 * The projection's credibility rests on `inflationFromStress` — a reduced-form
 * kernel with hand-tuned coefficients. This module backtests those exact
 * coefficients against the single largest peacetime monetary experiment in
 * modern U.S. history: the 2020–2021 M2 explosion and the inflation that
 * followed. If the kernel that powers the forward-looking policy simulation
 * cannot approximate an episode we actually observed, its peak-inflation and
 * stress-table numbers deserve no trust. The committed test pins the fit so
 * future coefficient edits cannot silently drift away from this anchor.
 *
 * Method. Monetary transmission to consumer prices operates with a lag of
 * roughly a year (Friedman's "long and variable lags"; the 2020 surge did not
 * show up in CPI until 2021–2022). We therefore feed each year's realized M2
 * growth into the kernel and read the modeled inflation out one year later,
 * then compare against realized CPI. No per-year tuning is applied: every year
 * uses the same published coefficients and the same pre-pandemic baseline.
 *
 * What the reduced form deliberately misses is stated in `caveats`: it has no
 * supply-shock, energy, or labor-market channel, so it cannot reproduce the
 * 2020 demand collapse (money was created but sat as precautionary savings) or
 * the 2022 energy spike. It is a monetary-transmission approximation, not a
 * structural macro model.
 */

const PERCENT = 0.01;

/**
 * Pre-pandemic structural inflation trend used as the kernel baseline for the
 * backtest: the 2015–2019 average CPI-U inflation rate (~1.8%/yr). This is the
 * historical analogue of `US_BASELINE.baselineInflation`; the 2026 baseline is
 * not appropriate for a 2020-anchored episode.
 */
export const HISTORICAL_BASELINE_INFLATION = 1.8 * PERCENT;

/**
 * Per-year tolerance band (percentage points) the modeled path must stay
 * within of realized CPI. Chosen so the committed test pins coefficient drift
 * while still allowing for the supply/energy channels the reduced form omits.
 */
export const BACKTEST_TOLERANCE_POINTS = 3.5 * PERCENT;

export interface HistoricalYearInput {
  /** Calendar year the M2 growth was realized. */
  readonly year: number;
  /** FRED M2SL December-over-December growth for `year`. */
  readonly m2GrowthYoY: number;
  /**
   * Federal deficit as a share of GDP for `year`, for transparency/display.
   * The kernel is NOT fed this separately: in 2020–2021 the deficit was the
   * source of the M2 surge (Fed purchases of Treasuries), so counting it again
   * would double-count the same dollars. The M2 growth number already carries
   * the fiscal injection. See `caveats`.
   */
  readonly deficitToGdp: number;
  /** BLS CPI-U December-over-December inflation realized in `year`. */
  readonly actualCpiInflation: number;
}

/**
 * FRED M2SL (December-over-December) and BLS CPI-U (December-over-December).
 * Money growth transmits to the following year's prices (see module doc).
 * Sources: FRED series M2SL and CPIAUCSL.
 */
export const HISTORICAL_SERIES: readonly HistoricalYearInput[] = [
  { year: 2019, m2GrowthYoY: 6.6 * PERCENT, deficitToGdp: 4.6 * PERCENT, actualCpiInflation: 2.3 * PERCENT },
  { year: 2020, m2GrowthYoY: 24.7 * PERCENT, deficitToGdp: 14.7 * PERCENT, actualCpiInflation: 1.4 * PERCENT },
  { year: 2021, m2GrowthYoY: 13.2 * PERCENT, deficitToGdp: 11.8 * PERCENT, actualCpiInflation: 7.0 * PERCENT },
  { year: 2022, m2GrowthYoY: -1.3 * PERCENT, deficitToGdp: 5.3 * PERCENT, actualCpiInflation: 6.5 * PERCENT },
  { year: 2023, m2GrowthYoY: -2.3 * PERCENT, deficitToGdp: 6.2 * PERCENT, actualCpiInflation: 3.4 * PERCENT },
];

export interface BacktestYear {
  readonly year: number;
  /** M2 growth (realized the prior year) driving this year's modeled price move. */
  readonly drivingM2Growth: number;
  readonly modeledInflation: number;
  readonly actualInflation: number;
  readonly errorPoints: number;
  readonly withinTolerance: boolean;
}

export interface BacktestPeak {
  readonly year: number;
  readonly inflation: number;
}

export interface HistoricalBacktest {
  readonly episode: string;
  readonly baselineInflation: number;
  readonly transmissionLagYears: number;
  readonly tolerancePoints: number;
  readonly years: readonly BacktestYear[];
  readonly meanAbsoluteErrorPoints: number;
  readonly modeledPeak: BacktestPeak;
  readonly actualPeak: BacktestPeak;
  /** Realized within-year CPI peak (headline YoY), for honest context. */
  readonly actualHeadlinePeak: { readonly label: string; readonly inflation: number };
  readonly allWithinTolerance: boolean;
  readonly caveats: readonly string[];
  readonly sources: readonly DataSource[];
}

/**
 * Runs the 2020–2023 backtest through the live `inflationFromStress` kernel and
 * returns the modeled-vs-actual comparison. Deterministic and input-free, so it
 * is computed once and reused by the API, the static site build, and the tests.
 */
export const runHistoricalBacktest = (): HistoricalBacktest => {
  const transmissionLagYears = 1;
  const years: BacktestYear[] = [];
  let confidence = 1;

  for (let index = transmissionLagYears; index < HISTORICAL_SERIES.length; index += 1) {
    const driver = HISTORICAL_SERIES[index - transmissionLagYears];
    const observed = HISTORICAL_SERIES[index];
    if (!driver || !observed) throw new Error("Historical series index out of range.");
    const stress = inflationFromStress({
      baselineInflation: HISTORICAL_BASELINE_INFLATION,
      // No independent demand-pull term: the money channel alone is under test.
      demandInflation: 0,
      moneyGrowth: driver.m2GrowthYoY,
      // Not fed separately — the monetized deficit is already inside M2 growth
      // (feeding both would double-count the same dollars). See caveats.
      monetizedDeficitRatio: 0,
      priorConfidence: confidence,
    });
    confidence = stress.confidence;
    const errorPoints = stress.inflation - observed.actualCpiInflation;
    years.push({
      year: observed.year,
      drivingM2Growth: driver.m2GrowthYoY,
      modeledInflation: stress.inflation,
      actualInflation: observed.actualCpiInflation,
      errorPoints,
      withinTolerance: Math.abs(errorPoints) <= BACKTEST_TOLERANCE_POINTS,
    });
  }

  const meanAbsoluteErrorPoints =
    years.reduce((sum, year) => sum + Math.abs(year.errorPoints), 0) /
    Math.max(1, years.length);
  const modeledPeak = years.reduce<BacktestPeak>(
    (peak, year) =>
      year.modeledInflation > peak.inflation
        ? { year: year.year, inflation: year.modeledInflation }
        : peak,
    { year: years[0]?.year ?? 0, inflation: -Infinity },
  );
  const actualPeak = years.reduce<BacktestPeak>(
    (peak, year) =>
      year.actualInflation > peak.inflation
        ? { year: year.year, inflation: year.actualInflation }
        : peak,
    { year: years[0]?.year ?? 0, inflation: -Infinity },
  );

  return {
    episode: "United States, 2020–2023 monetary expansion and inflation",
    baselineInflation: HISTORICAL_BASELINE_INFLATION,
    transmissionLagYears,
    tolerancePoints: BACKTEST_TOLERANCE_POINTS,
    years,
    meanAbsoluteErrorPoints,
    modeledPeak,
    actualPeak,
    actualHeadlinePeak: { label: "June 2022, headline CPI year-over-year", inflation: 9.1 * PERCENT },
    allWithinTolerance: years.every((year) => year.withinTolerance),
    caveats: [
      "The kernel is a monetary-transmission approximation with a one-year lag, not a structural macro model. It has no supply-shock, energy, or labor-market channel.",
      "It cannot reproduce 2020 itself: money was created while the pandemic collapsed demand, so newly created deposits sat as precautionary savings and prices barely moved. The reduced form maps money growth to prices with a lag and so overstates 2020 and understates the 2022 energy spike.",
      "The monetized fiscal deficit is represented through its M2 footprint rather than being added a second time, because in 2020–2021 the deficit was the source of the money growth. Deficit-to-GDP figures are shown for context only.",
      "December-over-December CPI is compared; the within-year headline peak (~9.1% in June 2022) was higher than any calendar-year figure.",
    ],
    sources: [
      {
        label: "M2 Money Stock (M2SL)",
        organization: "Federal Reserve Board via FRED",
        vintage: "December-over-December growth, 2019–2023",
        url: "https://fred.stlouisfed.org/series/M2SL",
      },
      {
        label: "Consumer Price Index for All Urban Consumers (CPIAUCSL)",
        organization: "U.S. Bureau of Labor Statistics via FRED",
        vintage: "December-over-December inflation, 2020–2023",
        url: "https://fred.stlouisfed.org/series/CPIAUCSL",
      },
      {
        label: "Federal deficit as a percentage of GDP (FYFSGDA188S)",
        organization: "OMB/BEA via FRED",
        vintage: "Fiscal years 2019–2023, context only",
        url: "https://fred.stlouisfed.org/series/FYFSGDA188S",
      },
    ],
  };
};

/** Precomputed backtest — deterministic, so it is safe to freeze at module load. */
export const HISTORICAL_BACKTEST: HistoricalBacktest = runHistoricalBacktest();
