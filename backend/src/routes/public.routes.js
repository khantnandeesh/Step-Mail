const express = require("express");

function createPublicRoutes({ controller, createHandleRateLimiter, sendEmailRateLimiter, pinAttemptLimiter }) {
  const router = express.Router();

  router.get("/generate", createHandleRateLimiter, controller.generate);
  router.get("/check/:localPart", controller.checkHandle);
  router.post("/create-custom", createHandleRateLimiter, controller.createCustom);

  router.get("/inbox/:email", controller.getInbox);
  router.post("/refresh/:email", controller.refreshEmail);
  router.delete("/inbox/:email/:emailId", controller.deleteInboxEmail);
  router.delete("/email/:email", controller.releaseEmail);

  router.post("/send", sendEmailRateLimiter, controller.sendEmail);
  router.get("/sent/:email", controller.getSentEmails);

  router.get("/stats", controller.getSystemStats);
  router.get("/visits", controller.recordVisit);
  router.get("/active", controller.getActiveHandles);
  router.get("/active/count", controller.getActiveCount);

  router.get("/forwarding/:email", controller.getForwarding);
  router.post("/forwarding/:email", controller.updateForwarding);

  router.post("/spam-feedback", controller.submitSpamFeedback);
  router.get("/spam-stats/:email", controller.getSpamStats);

  router.post("/lock", controller.lockEmail);
  router.post("/unlock", pinAttemptLimiter, controller.unlockEmail);
  router.post("/verify-unlock", controller.verifyUnlock);

  return router;
}

module.exports = {
  createPublicRoutes,
};
