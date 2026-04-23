module.exports = {
  apps: [
    {
      name: 'approve-to-squish',
      script: 'dist/src/index.js',
      cwd: __dirname,
      env_file: '.env',
      restart_delay: 5000,
      max_restarts: 20,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
