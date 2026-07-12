export const DEFAULT_PORT = 6020;
export const DEFAULT_HOST = "0.0.0.0";

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly environment: string;
}

export const parseServerConfig = (
  environment: Readonly<Record<string, string | undefined>>,
): ServerConfig => {
  const port = environment.PORT === undefined ? DEFAULT_PORT : Number(environment.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT must be an integer between 1 and 65535; received ${String(environment.PORT)}.`);
  }

  const host = environment.HOST?.trim() || DEFAULT_HOST;
  return {
    host,
    port,
    environment: environment.NODE_ENV?.trim() || "development",
  };
};
