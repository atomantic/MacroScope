// PM2 Ecosystem Configuration
// PortOS-compatible: labeled ports are the source of truth for app discovery.

const PORTS = {
  server: {
    ui: 6020,
    api: 6020,
  },
};

module.exports = {
  PORTS,
  apps: [
    {
      name: 'macroscope-server',
      script: 'dist/server/index.js',
      cwd: __dirname,
      interpreter: 'node',
      ports: PORTS.server,
      env: {
        NODE_ENV: 'production',
        HOST: '0.0.0.0',
        PORT: PORTS.server.api,
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 3000,
      max_memory_restart: '500M',
      kill_timeout: 12000,
      listen_timeout: 10000,
      time: true,
    },
  ],
};
