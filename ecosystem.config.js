module.exports = {
  apps: [
    {
      name: "goodcasino-server",
  script: "server2.js",
      cwd: __dirname,
      env: {
        NODE_ENV: "production"
      }
    },
    {
      name: "goodcasino-bot",
      script: "newtest3.js",
      cwd: __dirname,
      env: {
        NODE_ENV: "production"
      }
    },
    {
      name: "livechat-smart-payment",
      script: "smart-payment-ai.js",
      cwd: __dirname,
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
