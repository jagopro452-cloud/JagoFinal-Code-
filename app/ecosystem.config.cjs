// Requires Redis adapter for Socket.IO — see server/index.ts
module.exports = {
  apps: [{
    name: 'jago-pro',
    script: 'dist/index.js',
    instances: 'max',
    exec_mode: 'cluster',
    node_args: '--env-file=/var/www/jago/.env',
    env_production: {
      NODE_ENV: 'production',
      PORT: 5000,
    },
    max_memory_restart: '512M',
    restart_delay: 3000,
    max_restarts: 10,
    watch: false,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: '/var/log/jago/error.log',
    out_file: '/var/log/jago/out.log',
  }],
};
