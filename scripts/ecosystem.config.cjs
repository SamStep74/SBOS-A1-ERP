// SBOS-A1-ERP pm2 ecosystem file.
//
// pm2 is an alternative to systemd for hosts that don't have it
// (dev boxes, macOS, some cloud VMs). The shape mirrors the systemd
// unit: same env vars, same restart policy, same log file.
//
// Install:
//   npm i -g pm2
//   pm2 start scripts/ecosystem.config.cjs
//   pm2 startup       # generate the boot-time pm2 daemon
//   pm2 save          # save the process list for the daemon
//   pm2 logs          # tail stdout (the admin session token is here)
//
// The admin session token is printed to stdout on first boot — read
// it from `pm2 logs sbos-a1-erp --lines 50 --nostream --raw`.

module.exports = {
  apps: [
    {
      name: 'sbos-a1-erp',
      script: 'bin/sbos-server.mjs',
      // Use the system node (the one in the npm prefix). Adjust
      // `interpreter` if you're running a custom build.
      interpreter: 'node',
      // Match the systemd unit's restart policy. pm2's max_restarts
      // caps the crash loop; restart_delay is the gap between attempts.
      max_restarts: 5,
      restart_delay: 5000,
      // Memory cap: 512MB is enough for the bootable product on a
      // single node with a few thousand finance rows. Raise if you
      // have many tenants.
      max_memory_restart: '512M',
      // Logs: pipe to ./logs/ (override via PM2_LOG_DIR if you want
      // them somewhere else).
      out_file: './logs/sbos-a1-erp.out.log',
      error_file: './logs/sbos-a1-erp.err.log',
      merge_logs: true,
      time: true,
      // Env vars. Override per-deploy with `pm2 start ... --env production`
      // (or --env staging) — pm2 reads the matching `env_<name>` block.
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        HOST: '127.0.0.1',
        SBOS_DB: '/var/lib/sbos-a1-erp/sbos.db',
        SBOS_LOCALE: 'en',
        SBOS_AUTH_MODE: 'real',
        SBOS_ADMIN_TOKEN_FILE: '/var/lib/sbos-a1-erp/admin-token',
      },
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};
