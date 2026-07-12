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

    const [health, status, demo, baseline, shell] = await Promise.all([
      fetch(`${origin}/health`),
      fetch(`${origin}/api/status`),
      fetch(`${origin}/api/demo`),
      fetch(`${origin}/api/baseline/us`),
      fetch(origin),
    ]);

    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "healthy", service: "macroscope" });
    expect(await status.json()).toMatchObject({ deterministic: true });
    expect(await demo.json()).toMatchObject({
      delta: { borrowVsCash: { deposits: 20, loans: 20 } },
    });
    expect(await baseline.json()).toMatchObject({
      id: "us-2026-q1",
      households: 135_134_121,
    });
    expect(await shell.text()).toContain("<title>MacroScope</title>");
    const shellMarkup = await fetch(origin).then((response) => response.text());
    expect(shellMarkup).toContain('id="buyer-depth"');
    expect(shellMarkup).toContain('step="0.1"');
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
        ubi: { fundingRule: "magic" },
      }).errors,
    ).toEqual(
      expect.arrayContaining([
        "representedHouseholds must be at least sampleSize.",
        "fundingRule must be fixed, revenue-constrained, or smoothed.",
      ]),
    );
  });
});
