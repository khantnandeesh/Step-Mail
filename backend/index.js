const { createApp } = require("./src/app");
const { createWebSocketServer } = require("./src/ws/server");

const { app, httpServer, smtpServer, adminController, redis, setBroadcastToUser, config, addLog } = createApp();

// Set up WebSocket server
const ws = createWebSocketServer(httpServer, {
  redis,
  adminPassword: config.ADMIN_PASSWORD,
  getCpuHistory: () => adminController.getCpuHistory(),
  getCpuPercentage: () => adminController.getCpuPercentage(),
  listAllRateLimits: adminController.listRateLimits,
});

// Wire up WS broadcast to public controller
setBroadcastToUser(ws.broadcastToUser);

smtpServer.listen(config.SMTP_PORT, "0.0.0.0", () => {
  addLog("info", `SMTP server listening on port ${config.SMTP_PORT}`);
});

httpServer.listen(config.API_PORT, "0.0.0.0", () => {
  addLog("info", `API server started on port ${config.API_PORT}`);
  console.log(`API Server listening on port ${config.API_PORT}`);
  console.log(`Email domain: ${config.EMAIL_DOMAIN}`);
  console.log(`Email TTL: ${config.EMAIL_TTL} seconds`);
});
