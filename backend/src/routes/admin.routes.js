const express = require("express");

function createAdminRoutes({ adminController, adminAuth }) {
  const router = express.Router();

  router.post("/auth", adminController.authenticate);
  router.get("/stats", adminAuth, adminController.getStats);
  router.get("/cpu-history", adminAuth, (req, res) => {
    res.json({ success: true, history: adminController.getCpuHistory() });
  });
  router.get("/logs", adminAuth, adminController.listLogs);
  router.get("/handles", adminAuth, adminController.listHandles);
  router.delete("/handle/:email", adminAuth, adminController.deleteHandle);

  // Service status
  router.get("/service-status", adminAuth, adminController.getServiceStatus);
  router.put("/service-status", adminAuth, adminController.setServiceStatus);

  // Redeploy backend + frontend
  router.post("/redeploy", adminAuth, adminController.redeploy);

  // Rate limits per IP
  router.get("/rate-limits", adminAuth, adminController.listRateLimits);
  router.post("/rate-limits/:ip/reset", adminAuth, adminController.resetRateLimits);

  // Rate limit config
  router.get("/ratelimit-config", adminAuth, adminController.getRateLimitConfig);
  router.put("/ratelimit-config", adminAuth, adminController.setRateLimitConfig);

  return router;
}

module.exports = {
  createAdminRoutes,
};
