const express = require("express");
const cors = require("cors");
const http = require("http");

const CONFIG = require("./config");
const { addLog, getLogs } = require("./utils/logger");
const { createRedisClient } = require("./lib/redis");
const { createResendClient } = require("./lib/resend");
const { createRateLimiters, createPinAttemptLimiter } = require("./middlewares/rateLimit");
const { createAdminAuth } = require("./middlewares/adminAuth");
const { createSpamService } = require("./services/spam.service");
const { forwardEmail } = require("./services/forwarding.service");
const { createPublicController } = require("./controllers/public.controller");
const { createAdminController } = require("./controllers/admin.controller");
const { createPublicRoutes } = require("./routes/public.routes");
const { createAdminRoutes } = require("./routes/admin.routes");
const { createSmtpServer } = require("./smtp/createSmtpServer");

function createApp() {
  const app = express();
  const httpServer = http.createServer(app);
  const redis = createRedisClient(CONFIG.REDIS_URL);
  const resend = createResendClient(CONFIG.RESEND_API_KEY);

  // Placeholder for WS broadcast function (set from index.js after WS server is created)
  let broadcastToUser = (email, data) => {};
  const setBroadcastToUser = (fn) => { broadcastToUser = fn; };

  redis.on("connect", () => {
    addLog("info", "Connected to Redis");
  });

  redis.on("error", (err) => {
    addLog("error", "Redis error", { error: err.message });
  });

  const spamService = createSpamService(CONFIG);
  const forwardingService = { forwardEmail };
  const { getClientIP, getEffectiveLimit, getRateLimitStatus, listAllRateLimits, resetRateLimitsForIP, generalRateLimiter, createHandleRateLimiter, sendEmailRateLimiter } =
    createRateLimiters(redis);
  const pinAttemptLimiter = createPinAttemptLimiter(redis, CONFIG);

  const publicController = createPublicController({
    config: CONFIG,
    redis,
    resend,
    spamService,
    forwardingService,
    broadcastToUser,
  });

  const adminController = createAdminController({
    config: CONFIG,
    redis,
    addLog,
    getLogs,
    getClientIP,
    listAllRateLimits,
    resetRateLimitsForIP,
  });

  const adminAuth = createAdminAuth(CONFIG);

  app.use(cors());
  app.use(express.json({ limit: "25mb" }));
  app.set("trust proxy", 1);

  app.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Service status middleware — blocks public API when service is off
  const serviceStatusMiddleware = async (req, res, next) => {
    if (req.path === "/health" || req.path.startsWith("/admin")) return next();
    try {
      const status = await redis.get("service:status");
      if (status === "off") {
        return res.status(503).json({
          success: false,
          error: "Service is currently unavailable. Please try again later.",
          status: "maintenance",
        });
      }
    } catch (e) {
      console.error("Failed to check service status:", e.message);
    }
    next();
  };

  // Public service status endpoint
  app.get("/api/service-status", async (req, res) => {
    try {
      const status = await redis.get("service:status") || "on";
      res.json({ status });
    } catch (e) {
      res.status(500).json({ error: "Failed to get service status" });
    }
  });

  // Per-user rate limit status endpoint
  app.get("/api/rate-limit-status", async (req, res) => {
    try {
      const ip = getClientIP(req);
      const status = await getRateLimitStatus(ip);
      res.json({ success: true, ip, limits: status });
    } catch (e) {
      res.status(500).json({ success: false, error: "Failed to get rate limit status" });
    }
  });

  app.use("/api", serviceStatusMiddleware);
  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/admin")) return next();
    return generalRateLimiter(req, res, next);
  });
  app.use("/api", createPublicRoutes({ controller: publicController, createHandleRateLimiter, sendEmailRateLimiter, pinAttemptLimiter }));
  app.use("/api/admin", createAdminRoutes({ adminController, adminAuth }));

  const smtpServer = createSmtpServer({
    config: CONFIG,
    processIncomingEmail: publicController.processIncomingEmail,
    addLog,
  });

  return {
    app,
    httpServer,
    smtpServer,
    adminController,
    redis,
    setBroadcastToUser,
    config: CONFIG,
    addLog,
  };
}

module.exports = {
  createApp,
};
