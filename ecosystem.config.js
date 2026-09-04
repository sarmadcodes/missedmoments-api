/**
 * PM2 process definition for production.
 *
 * Runs the COMPILED build (dist/server.js), never `tsx watch` -- that is a
 * dev-only tool that recompiles on every file change and is not meant to
 * survive a real server's uptime.
 *
 *   npm run build
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *
 * `pm2 save` plus `pm2 startup` (run once, follow the command it prints) is
 * what makes this survive a server reboot -- without both, PM2 itself has to
 * be manually restarted after any reboot.
 */
module.exports = {
  apps: [
    {
      name: 'missedmoments-api',
      script: 'dist/server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '400M',
      // PM2's own restart backoff already handles a crash loop; this just
      // caps it so a persistently broken deploy doesn't spin forever.
      max_restarts: 10,
      min_uptime: '10s',
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      time: true,
    },
  ],
};
