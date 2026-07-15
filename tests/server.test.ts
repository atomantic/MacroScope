import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import {
  createDemoComparison,
  parseComparisonRequest,
  parseServerConfig,
} from "../src/index.js";

const servers: ReturnType<ReturnType<typeof createApp>["listen"]>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("PortOS server", () => {
  it("validates environment-driven server configuration", () => {
    expect(parseServerConfig({})).toMatchObject({ host: "0.0.0.0", port: 6020 });
    expect(parseServerConfig({ HOST: "127.0.0.1", PORT: "6123" })).toMatchObject({
      host: "127.0.0.1",
      port: 6123,
    });
    expect(() => parseServerConfig({ PORT: "invalid" })).toThrow(/PORT must be/);
  });

  it("serves health, status, demo, and the application shell", async () => {
    const app = createApp({ startedAt: Date.now() - 5_000 });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;

    const [health, status, demo, baseline, backtest, constants, shell] = await Promise.all([
      fetch(`${origin}/health`),
      fetch(`${origin}/api/status`),
      fetch(`${origin}/api/demo`),
      fetch(`${origin}/api/baseline/us`),
      fetch(`${origin}/api/validation/historical`),
      fetch(`${origin}/api/model/constants`),
      fetch(origin),
    ]);

    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "healthy", service: "macroscope" });
    const statusPayload = await status.json();
    expect(statusPayload).toMatchObject({
      deterministic: true,
      calibration: {
        vintage: "2026:Q1",
        residualAssetClass: { modelClass: "otherAssets", includedInModel: true },
      },
    });
    expect(statusPayload.implemented).toEqual(
      expect.arrayContaining([
        "federal-reserve-dfa-calibration",
        "instrument-level-federal-reserve-dfa-calibration",
      ]),
    );
    expect(backtest.status).toBe(200);
    expect(await backtest.json()).toMatchObject({
      modeledPeak: { year: 2021 },
      allWithinTolerance: true,
    });
    expect(await demo.json()).toMatchObject({
      delta: { borrowVsCash: { deposits: 20, loans: 20 } },
    });
    const baselinePayload = await baseline.json();
    expect(baselinePayload).toMatchObject({
      id: "us-2026-q1",
      households: 135_134_121,
      calibration: {
        vintage: "2026:Q1",
        tolerance: 0.01,
      },
    });
    expect(baselinePayload.wealthGroups[0]).toMatchObject({
      deposits: 793_232_000_000,
      publicEquity: 587_223_000_000,
      realEstate: 4_826_745_000_000,
    });
    expect(constants.status).toBe(200);
    const constantsPayload = await constants.json();
    expect(Array.isArray(constantsPayload.constants)).toBe(true);
    expect(constantsPayload.constants.some((entry: { tunable: boolean }) => entry.tunable)).toBe(
      true,
    );
    expect(await shell.text()).toContain("<title>MacroScope</title>");
    const shellMarkup = await fetch(origin).then((response) => response.text());
    expect(shellMarkup).toContain('id="buyer-depth"');
    expect(shellMarkup).toContain('step="0.1"');
    expect(shellMarkup).toContain('data-preset="top-one"');
    expect(shellMarkup).toContain('id="theory-chart"');
    expect(shellMarkup).toContain('id="backtest-chart"');
    expect(shellMarkup).toContain('id="validation-heading"');
    expect(shellMarkup).toContain('id="avoidance-elasticity"');
    expect(shellMarkup).toContain('id="expatriation-share"');
    expect(shellMarkup).toContain('id="private-business-inclusion"');
    expect(shellMarkup).toContain('data-behavior-preset="scandinavian"');
    expect(shellMarkup).toContain('id="wage-pass-through"');
    expect(shellMarkup).toContain('id="monetary-offset"');
    expect(shellMarkup).toContain('id="model-constants-body"');
    expect(shellMarkup).toContain('id="calibration-summary"');
    expect(shellMarkup).toContain(
      '<dialog class="scenario-drawer" id="scenario-drawer" aria-labelledby="scenario-drawer-title">',
    );
    expect(shellMarkup).toContain('aria-controls="scenario-drawer"');
    expect(shellMarkup).toContain('aria-expanded="false"');
    expect(shellMarkup).toMatch(
      /id="scenario-recalc-status"[\s\S]*?role="status"[\s\S]*?aria-live="polite"/,
    );
    expect(shellMarkup).toContain('id="scenario-drawer-close"');
    expect(shellMarkup).toContain('aria-label="Close scenario editor"');
    expect(shellMarkup).toMatch(
      /id="drawer-action-feedback"[\s\S]*?role="status"[\s\S]*?aria-live="polite"/,
    );
    expect(shellMarkup).toContain('id="scenario-drawer-done"');
    expect(shellMarkup.match(/id="scenario-form"/g)).toHaveLength(1);
    const shellIds = [...shellMarkup.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(shellIds).size).toBe(shellIds.length);
  });

  it("validates and runs comparison requests over HTTP", async () => {
    const app = createApp();
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;
    const defaults = await fetch(`${origin}/api/scenarios/default`).then((response) =>
      response.json(),
    );

    const validResponse = await fetch(`${origin}/api/scenarios/compare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...defaults,
        sampleSize: 500,
        representedHouseholds: 5_000,
      }),
    });
    expect(validResponse.status).toBe(200);
    const result = await validResponse.json();
    expect(result.strategies["borrow-first"].accounting.passed).toBe(true);
    expect(result.projection.years).toHaveLength(11);

    const invalidResponse = await fetch(`${origin}/api/scenarios/compare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sampleSize: 5 }),
    });
    expect(invalidResponse.status).toBe(400);
    expect(await invalidResponse.json()).toMatchObject({
      error: "Invalid comparison request.",
    });

    const malformedResponse = await fetch(`${origin}/api/scenarios/compare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(malformedResponse.status).toBe(400);
    expect(await malformedResponse.json()).toEqual({
      error: "Request body contains invalid JSON.",
    });
  });

  it("validates and runs sensitivity requests over HTTP", async () => {
    const app = createApp();
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;
    const defaults = await fetch(`${origin}/api/scenarios/default`).then((response) =>
      response.json(),
    );

    const validResponse = await fetch(`${origin}/api/scenarios/sensitivity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...defaults, sampleSize: 500, representedHouseholds: 5_000 }),
    });
    expect(validResponse.status).toBe(200);
    const analysis = await validResponse.json();
    expect(analysis.dials.length).toBeGreaterThan(0);
    expect(["beneficial", "mixed", "harmful"]).toContain(analysis.base.verdict);
    expect(analysis.runs).toBeGreaterThan(analysis.dials.length);

    const invalidResponse = await fetch(`${origin}/api/scenarios/sensitivity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sampleSize: 5 }),
    });
    expect(invalidResponse.status).toBe(400);
    expect(await invalidResponse.json()).toMatchObject({
      error: "Invalid comparison request.",
    });
  });

  it("streams progress and returns joint uncertainty bands over HTTP", async () => {
    const app = createApp();
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;
    const defaults = await fetch(`${origin}/api/scenarios/default`).then((response) =>
      response.json(),
    );
    const body = {
      request: { ...defaults, sampleSize: 100, representedHouseholds: 1_000 },
      options: { draws: 32, seed: 101, populationMode: "fixed", populationReplicates: 4 },
    };

    const jsonResponse = await fetch(`${origin}/api/scenarios/uncertainty`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    expect(jsonResponse.status).toBe(200);
    const analysis = await jsonResponse.json();
    expect(analysis.runs).toBe(32);
    expect(analysis.metrics.length).toBeGreaterThan(0);

    const streamResponse = await fetch(`${origin}/api/scenarios/uncertainty`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "Application/X-NDJSON",
      },
      body: JSON.stringify(body),
    });
    expect(streamResponse.status).toBe(200);
    const messages = (await streamResponse.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(messages.some((message) => message.progress?.completed === 0)).toBe(true);
    expect(messages.at(-1)?.result.runs).toBe(32);

    const invalidResponse = await fetch(`${origin}/api/scenarios/uncertainty`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, options: { ...body.options, draws: 2 } }),
    });
    expect(invalidResponse.status).toBe(400);
    expect(await invalidResponse.json()).toMatchObject({
      error: "Invalid uncertainty request.",
    });
  });

  it("runs the engine-backed comparison deterministically", () => {
    expect(createDemoComparison()).toEqual(createDemoComparison());
  });

  it("rejects malformed scenario input before running the engine", () => {
    expect(parseComparisonRequest(null).errors).toContain(
      "Request body must be a JSON object.",
    );
    expect(
      parseComparisonRequest({
        sampleSize: 100,
        representedHouseholds: 50,
        wealthTax: { targetMode: "magic" },
        ubi: {
          fundingRule: "magic",
          surplusUse: "magic",
          benefitIndexation: "magic",
          serviceEffectiveness: "magic",
        },
      }).errors,
    ).toEqual(
      expect.arrayContaining([
        "representedHouseholds must be at least sampleSize.",
        "targetMode must be exemption or top-share.",
        "fundingRule must be fixed, revenue-constrained, or smoothed.",
        "surplusUse must be debt-reduction, additional-services, rebate, or treasury-balance.",
        "benefitIndexation must be none or cpi.",
        "serviceEffectiveness must be unscored, zero, base, or high.",
      ]),
    );
  });

  it("accepts a monotonic graduated wealth-tax schedule", () => {
    const parsed = parseComparisonRequest({
      wealthTax: {
        brackets: [
          { threshold: 50_000_000, rate: 0.02 },
          { threshold: 1_000_000_000, rate: 0.06 },
        ],
      },
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.value?.wealthTax.brackets).toEqual([
      { threshold: 50_000_000, rate: 0.02 },
      { threshold: 1_000_000_000, rate: 0.06 },
    ]);
  });

  it("rejects non-monotonic bracket thresholds and rates", () => {
    const errors = parseComparisonRequest({
      wealthTax: {
        brackets: [
          { threshold: 1_000_000_000, rate: 0.06 },
          { threshold: 50_000_000, rate: 0.02 },
        ],
      },
    }).errors;
    expect(errors).toEqual(
      expect.arrayContaining([
        "Bracket thresholds must be strictly increasing.",
        "Bracket rates must be nondecreasing across thresholds.",
      ]),
    );
  });

  it("bounds the taxpayer-response dials", () => {
    expect(
      parseComparisonRequest({
        behavior: {
          avoidanceElasticity: 5,
          expatriationShare: 2,
          privateBusinessInclusionRate: 3,
        },
      }).errors,
    ).toEqual(
      expect.arrayContaining([
        "avoidanceElasticity must be between 0 and 0.5.",
        "expatriationShare must be between 0 and 0.9.",
        "privateBusinessInclusionRate must be between 0 and 1.",
      ]),
    );
    const parsed = parseComparisonRequest({
      behavior: {
        avoidanceElasticity: 0.1,
        expatriationShare: 0.2,
        privateBusinessInclusionRate: 0.6,
      },
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.value?.behavior).toMatchObject({
      avoidanceElasticity: 0.1,
      expatriationShare: 0.2,
      privateBusinessInclusionRate: 0.6,
    });
  });
});
