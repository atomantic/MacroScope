import { createApp } from "./app.js";
import { parseServerConfig } from "./config.js";

const config = parseServerConfig(process.env);
const app = createApp();
const server = app.listen(config.port, config.host, () => {
  console.log(`🚀 MacroScope listening on ${config.host}:${config.port}`);
});

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🛑 MacroScope received ${signal}; shutting down`);

  const timeout = setTimeout(() => {
    console.error("❌ MacroScope graceful shutdown timed out");
    process.exit(1);
  }, 10_000);
  timeout.unref();

  server.close((error) => {
    clearTimeout(timeout);
    if (error) {
      console.error(`❌ MacroScope shutdown failed: ${error.message}`);
      process.exit(1);
    }
    console.log("✅ MacroScope stopped");
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
