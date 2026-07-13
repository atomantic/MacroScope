import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { DEFAULT_COMPARISON_REQUEST, compareScenarios } from "../src/index.js";

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

const startServer = async (): Promise<string> => {
  const server = createApp().listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

describe("browser engine parity", () => {
  it("produces identical JSON to the server for the same request", async () => {
    const origin = await startServer();
    const request = {
      ...DEFAULT_COMPARISON_REQUEST,
      seed: 99,
      sampleSize: 500,
      representedHouseholds: 5_000,
      wealthTax: { ...DEFAULT_COMPARISON_REQUEST.wealthTax, rate: 0.03 },
      ubi: { ...DEFAULT_COMPARISON_REQUEST.ubi, adultMonthlyBenefit: 750 },
    };

    const serverJson = await fetch(`${origin}/api/scenarios/compare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }).then((response) => response.text());

    const browserResponse = compareScenarios(request);
    expect(browserResponse.ok).toBe(true);
    if (!browserResponse.ok) return;
    expect(JSON.stringify(browserResponse.result)).toBe(serverJson);
  });

  it("rejects invalid input with the same errors as the server", async () => {
    const origin = await startServer();
    const invalid = { sampleSize: 5, wealthTax: { targetMode: "magic" } };

    const serverPayload = await fetch(`${origin}/api/scenarios/compare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(invalid),
    });
    expect(serverPayload.status).toBe(400);
    const serverError = await serverPayload.json();

    const browserResponse = compareScenarios(invalid);
    expect(browserResponse.ok).toBe(false);
    if (browserResponse.ok) return;
    expect(browserResponse.error).toBe(serverError.error);
    expect([...browserResponse.details]).toEqual(serverError.details);
  });

  it("is deterministic across repeated runs", () => {
    const request = {
      ...DEFAULT_COMPARISON_REQUEST,
      sampleSize: 500,
      representedHouseholds: 5_000,
    };
    expect(JSON.stringify(compareScenarios(request))).toBe(
      JSON.stringify(compareScenarios(request)),
    );
  });

  it("is the same module the web worker entry imports", async () => {
    const workerSource = await readFile(
      new URL("../public/engine-worker.js", import.meta.url),
      "utf8",
    );
    expect(workerSource).toContain('from "./engine/browser/engine.js"');
    expect(workerSource).toContain("compareScenarios");
  });
});
