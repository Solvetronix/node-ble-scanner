// PM2 ecosystem configuration for backend
// NOTE: Keep comments in English per project convention
module.exports = {
  apps: [
    {
      name: 'node_ble',
      script: 'server.js',
      cwd: __dirname,
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
        USE_BLUEZ: '1'
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_restarts: 10,
      restart_delay: 3000
    }
  ]
};


