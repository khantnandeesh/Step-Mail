const os = require("os");
const crypto = require("crypto");
const { nanoid } = require("nanoid");

function createPublicController({ config, redis, resend, spamService, forwardingService, broadcastToUser }) {
  const checkLockAccess = async (email, req, res) => {
    const locked = await redis.exists(`lock:${email}`);
    if (!locked) return true;
    const token = req.headers["x-unlock-token"];
    if (!token) {
      return res.status(403).json({ success: false, error: "This email is locked. Unlock it first." });
    }
    const data = await redis.get(`unlock:${email}`);
    if (!data || JSON.parse(data).token !== token) {
      return res.status(403).json({ success: false, error: "This email is locked. Unlock it first." });
    }
    return true;
  };
  const generate = async (req, res) => {
    try {
      const chars = "abcdefghjkmnpqrstuvwxyz23456789";
      let localPart = "";
      for (let i = 0; i < 6; i++) {
        localPart += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      const email = `${localPart}@${config.EMAIL_DOMAIN}`;

      const emailKey = `email:${email}`;
      await redis.set(
        emailKey,
        JSON.stringify({
          email,
          createdAt: new Date().toISOString(),
        }),
        "EX",
        config.INBOX_TTL,
      );

      const expiresAt = new Date(Date.now() + config.INBOX_TTL * 1000).toISOString();
      res.json({ success: true, email, expiresAt, ttl: config.INBOX_TTL });
    } catch (error) {
      console.error("Error generating email:", error);
      res.status(500).json({ success: false, error: "Failed to generate email" });
    }
  };

  const checkHandle = async (req, res) => {
    try {
      const localPart = req.params.localPart.toLowerCase().trim();

      if (!localPart || localPart.length < 3 || localPart.length > 20) {
        return res.json({ available: false, error: "Handle must be 3-20 characters" });
      }

      if (!/^[a-z0-9._-]+$/.test(localPart)) {
        return res.json({
          available: false,
          error: "Only letters, numbers, dots, underscores, hyphens allowed",
        });
      }

      const email = `${localPart}@${config.EMAIL_DOMAIN}`;
      const exists = await redis.exists(`email:${email}`);
      const locked = await redis.exists(`lock:${email}`);
      res.json({ available: !exists && !locked, email });
    } catch (error) {
      console.error("Error checking email:", error);
      res.status(500).json({ available: false, error: "Failed to check availability" });
    }
  };

  const createCustom = async (req, res) => {
    try {
      const { localPart, ttlMinutes } = req.body;
      const cleanLocalPart = (localPart || "").toLowerCase().trim();

      if (!cleanLocalPart || cleanLocalPart.length < 3 || cleanLocalPart.length > 20) {
        return res.status(400).json({ success: false, error: "Handle must be 3-20 characters" });
      }

      if (!/^[a-z0-9._-]+$/.test(cleanLocalPart)) {
        return res.status(400).json({
          success: false,
          error: "Only letters, numbers, dots, underscores, hyphens allowed",
        });
      }

      const isPermanent = parseInt(ttlMinutes, 10) === -1;
      const ttl = isPermanent
        ? -1
        : Math.min(Math.max(parseInt(ttlMinutes, 10) || 10, 1), 525600);
      const ttlSeconds = isPermanent ? -1 : ttl * 60;

      const email = `${cleanLocalPart}@${config.EMAIL_DOMAIN}`;
      const emailKey = `email:${email}`;

      const exists = await redis.exists(emailKey);
      if (exists) {
        return res.status(409).json({ success: false, error: "This email handle is already taken" });
      }

      const emailData = JSON.stringify({
        email,
        createdAt: new Date().toISOString(),
        custom: true,
        permanent: isPermanent,
      });

      if (isPermanent) {
        await redis.set(emailKey, emailData);
      } else {
        await redis.set(emailKey, emailData, "EX", ttlSeconds);
      }

      const expiresAt = isPermanent ? null : new Date(Date.now() + ttlSeconds * 1000).toISOString();

      res.json({
        success: true,
        email,
        expiresAt,
        ttl: isPermanent ? -1 : ttlSeconds,
        permanent: isPermanent,
      });
    } catch (error) {
      console.error("Error creating custom email:", error);
      res.status(500).json({ success: false, error: "Failed to create custom email" });
    }
  };

  const getInbox = async (req, res) => {
    try {
      const email = req.params.email.toLowerCase();
      if (!(await checkLockAccess(email, req, res))) return;

      const inboxKey = `inbox:${email}`;
      const emailKey = `email:${email}`;

      const ttl = await redis.ttl(emailKey);
      const emails = await redis.lrange(inboxKey, 0, -1);
      const parsedEmails = emails.map((e) => JSON.parse(e));
      parsedEmails.sort((a, b) => new Date(b.date) - new Date(a.date));

      res.json({
        success: true,
        email,
        ttl: ttl > 0 ? ttl : 0,
        count: parsedEmails.length,
        messages: parsedEmails,
      });
    } catch (error) {
      console.error("Error fetching inbox:", error);
      res.status(500).json({ success: false, error: "Failed to fetch inbox" });
    }
  };

  const refreshEmail = async (req, res) => {
    try {
      const email = req.params.email.toLowerCase();
      if (!(await checkLockAccess(email, req, res))) return;

      const emailKey = `email:${email}`;
      const inboxKey = `inbox:${email}`;

      const exists = await redis.exists(emailKey);
      if (!exists) {
        return res.status(404).json({ success: false, error: "Email not found or expired" });
      }

      await redis.expire(emailKey, config.INBOX_TTL);
      await redis.expire(inboxKey, config.INBOX_TTL);

      const expiresAt = new Date(Date.now() + config.INBOX_TTL * 1000).toISOString();
      res.json({ success: true, email, expiresAt, ttl: config.INBOX_TTL });
    } catch (error) {
      console.error("Error refreshing email:", error);
      res.status(500).json({ success: false, error: "Failed to refresh email" });
    }
  };

  const deleteInboxEmail = async (req, res) => {
    try {
      const email = req.params.email.toLowerCase();
      if (!(await checkLockAccess(email, req, res))) return;

      const emailId = req.params.emailId;
      const inboxKey = `inbox:${email}`;

      const emails = await redis.lrange(inboxKey, 0, -1);
      for (const emailJson of emails) {
        const parsed = JSON.parse(emailJson);
        if (parsed.id === emailId) {
          await redis.lrem(inboxKey, 1, emailJson);
          return res.json({ success: true, message: "Email deleted" });
        }
      }

      res.status(404).json({ success: false, error: "Email not found" });
    } catch (error) {
      console.error("Error deleting email:", error);
      res.status(500).json({ success: false, error: "Failed to delete email" });
    }
  };

  const releaseEmail = async (req, res) => {
    try {
      const email = req.params.email.toLowerCase();
      if (!(await checkLockAccess(email, req, res))) return;

      await redis.del(`email:${email}`);
      await redis.del(`inbox:${email}`);
      await redis.del(`sent:${email}`);
      await redis.del(`lock:${email}`);
      await redis.del(`unlock:${email}`);
      await redis.del(`pinattempts:${email}`);
      res.json({ success: true, message: "Email released" });
    } catch (error) {
      console.error("Error releasing email:", error);
      res.status(500).json({ success: false, error: "Failed to release email" });
    }
  };

  const sendEmail = async (req, res) => {
    try {
      const { from, fromName, to, subject, text, html, attachments } = req.body;

      if (!from || !to || !subject) {
        return res.status(400).json({
          success: false,
          error: "Missing required fields: from, to, subject",
        });
      }

      const fromLower = from.toLowerCase();
      const fromDomain = fromLower.split("@")[1];
      if (fromDomain !== config.EMAIL_DOMAIN) {
        return res.status(400).json({
          success: false,
          error: `Can only send from @${config.EMAIL_DOMAIN}`,
        });
      }

      const emailKey = `email:${fromLower}`;
      const exists = await redis.exists(emailKey);
      if (!exists) {
        return res.status(400).json({
          success: false,
          error: "Sender email not found or expired. Generate a new one.",
        });
      }

      if (!(await checkLockAccess(fromLower, req, res))) return;

      if (!resend) {
        return res.status(500).json({ success: false, error: "Email sending not configured" });
      }

      const resendAttachments = (attachments || []).map((att) => ({
        filename: att.filename,
        content: Buffer.from(att.content, "base64"),
      }));

      const senderName = fromName || "StepMail";
      const { data, error } = await resend.emails.send({
        from: `${senderName} <${fromLower}>`,
        to: Array.isArray(to) ? to : [to],
        subject,
        text: text || "",
        html: html || undefined,
        attachments: resendAttachments.length > 0 ? resendAttachments : undefined,
      });

      if (error) {
        return res.status(500).json({ success: false, error: error.message || "Failed to send email" });
      }

      const sentKey = `sent:${fromLower}`;
      const sentEmail = {
        id: data.id,
        to: Array.isArray(to) ? to.join(", ") : to,
        subject,
        text: text || "",
        date: new Date().toISOString(),
        attachmentCount: (attachments || []).length,
      };
      await redis.lpush(sentKey, JSON.stringify(sentEmail));

      const emailTtl = await redis.ttl(emailKey);
      if (emailTtl > 0) {
        await redis.expire(sentKey, emailTtl);
      }

      // Notify connected clients that a sent message was added
      broadcastToUser(fromLower, { type: "new-sent", data: { id: sentEmail.id, to: sentEmail.to, subject: sentEmail.subject, date: sentEmail.date } });

      res.json({ success: true, messageId: data.id, message: "Email sent successfully" });
    } catch (error) {
      console.error("Error sending email:", error);
      res.status(500).json({ success: false, error: "Failed to send email" });
    }
  };

  const getSentEmails = async (req, res) => {
    try {
      const email = req.params.email.toLowerCase();
      if (!(await checkLockAccess(email, req, res))) return;

      const sentKey = `sent:${email}`;

      const emails = await redis.lrange(sentKey, 0, -1);
      const parsedEmails = emails.map((e) => JSON.parse(e));
      parsedEmails.sort((a, b) => new Date(b.date) - new Date(a.date));

      res.json({ success: true, email, count: parsedEmails.length, messages: parsedEmails });
    } catch (error) {
      console.error("Error fetching sent:", error);
      res.status(500).json({ success: false, error: "Failed to fetch sent emails" });
    }
  };

  const getSystemStats = (req, res) => {
    const cpus = os.cpus();
    const loadAvg = os.loadavg();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const cpuPercentage = Math.min(100, (loadAvg[0] / cpus.length) * 100);

    res.json({
      success: true,
      cpu: {
        cores: cpus.length,
        loadAvg: loadAvg[0].toFixed(2),
        percentage: cpuPercentage.toFixed(1),
      },
      memory: {
        total: Math.round((totalMem / 1024 / 1024 / 1024) * 100) / 100,
        used: Math.round((usedMem / 1024 / 1024 / 1024) * 100) / 100,
        percentage: ((usedMem / totalMem) * 100).toFixed(1),
      },
      uptime: Math.floor(os.uptime()),
      serverTime: new Date().toISOString(),
      version: require("../../package.json").version || "1.0.0",
    });
  };

  const recordVisit = async (req, res) => {
    try {
      const count = await redis.incr("visits");
      res.json({ success: true, visits: count });
    } catch (error) {
      console.error("Error recording visit:", error);
      res.status(500).json({ success: false, error: "Failed to record visit" });
    }
  };

  const getActiveHandles = async (req, res) => {
    try {
      const cursor = req.query.cursor || "0";
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

      const [nextCursor, keys] = await redis.scan(cursor, "MATCH", "email:*", "COUNT", limit * 2);
      const emailKeys = keys
        .filter((key) => key.startsWith("email:") && !key.includes(":inbox:") && !key.includes(":sent:"))
        .slice(0, limit);

      const pipeline = redis.pipeline();
      emailKeys.forEach((key) => {
        pipeline.ttl(key);
        pipeline.get(key);
        pipeline.exists(key.replace("email:", "lock:"));
      });
      const results = await pipeline.exec();

      const handles = [];
      for (let i = 0; i < emailKeys.length; i++) {
        const ttl = results[i * 3][1];
        const dataStr = results[i * 3 + 1][1];
        const isLocked = results[i * 3 + 2][1];

        if (ttl !== -2 && dataStr && !isLocked) {
          try {
            const data = JSON.parse(dataStr);
            const email = emailKeys[i].replace("email:", "");
            handles.push({
              email,
              handle: email.split("@")[0],
              createdAt: data.createdAt,
              ttl: ttl === -1 ? null : ttl,
              isPermanent: ttl === -1,
              hasForwarding: !!data.forwardTo,
            });
          } catch (e) {
            // Ignore malformed values.
          }
        }
      }

      const totalKeys = await redis.dbsize();
      res.json({
        success: true,
        handles,
        cursor: nextCursor,
        hasMore: nextCursor !== "0",
        count: handles.length,
        totalApprox: totalKeys,
      });
    } catch (error) {
      console.error("Error fetching active handles:", error);
      res.status(500).json({ success: false, error: "Failed to fetch handles" });
    }
  };

  const getActiveCount = async (req, res) => {
    try {
      let cursor = "0";
      let count = 0;

      do {
        const [nextCursor, keys] = await redis.scan(cursor, "MATCH", "email:*@*", "COUNT", 1000);
        count += keys.filter((k) => !k.includes(":inbox:") && !k.includes(":sent:")).length;
        cursor = nextCursor;
      } while (cursor !== "0");

      res.json({ success: true, count, timestamp: new Date().toISOString() });
    } catch (error) {
      console.error("Error counting active handles:", error);
      res.status(500).json({ success: false, error: "Failed to count" });
    }
  };

  const getForwarding = async (req, res) => {
    try {
      const email = req.params.email.toLowerCase();
      if (!(await checkLockAccess(email, req, res))) return;

      const emailDataStr = await redis.get(`email:${email}`);

      if (!emailDataStr) {
        return res.status(404).json({ success: false, error: "Email not found" });
      }

      const emailData = JSON.parse(emailDataStr);
      res.json({
        success: true,
        forwardEnabled: emailData.forwardEnabled || false,
        forwardTo: emailData.forwardTo || "",
      });
    } catch (error) {
      console.error("Error getting forwarding settings:", error);
      res.status(500).json({ success: false, error: "Failed to get settings" });
    }
  };

  const updateForwarding = async (req, res) => {
    try {
      const email = req.params.email.toLowerCase();
      if (!(await checkLockAccess(email, req, res))) return;

      const { forwardEnabled, forwardTo } = req.body;
      const emailKey = `email:${email}`;

      const emailDataStr = await redis.get(emailKey);
      if (!emailDataStr) {
        return res.status(404).json({ success: false, error: "Email not found" });
      }

      const emailData = JSON.parse(emailDataStr);

      if (forwardEnabled && forwardTo) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(forwardTo)) {
          return res.status(400).json({ success: false, error: "Invalid email format" });
        }
        if (forwardTo.endsWith(`@${config.EMAIL_DOMAIN}`)) {
          return res.status(400).json({ success: false, error: "Cannot forward to this domain" });
        }
      }

      emailData.forwardEnabled = !!forwardEnabled;
      emailData.forwardTo = forwardEnabled ? forwardTo || "" : "";

      const ttl = await redis.ttl(emailKey);
      if (ttl > 0) {
        await redis.set(emailKey, JSON.stringify(emailData), "EX", ttl);
      } else {
        await redis.set(emailKey, JSON.stringify(emailData));
      }

      res.json({
        success: true,
        forwardEnabled: emailData.forwardEnabled,
        forwardTo: emailData.forwardTo,
      });
    } catch (error) {
      console.error("Error updating forwarding settings:", error);
      res.status(500).json({ success: false, error: "Failed to update settings" });
    }
  };

  const submitSpamFeedback = async (req, res) => {
    try {
      const { email, messageId, isSpam } = req.body;

      if (!email || !messageId || typeof isSpam !== "boolean") {
        return res.status(400).json({ success: false, error: "Invalid request" });
      }

      const emailLower = email.toLowerCase();
      if (!(await checkLockAccess(emailLower, req, res))) return;

      const inboxKey = `inbox:${emailLower}`;
      const feedbackKey = `feedback:${emailLower}`;

      const messages = await redis.lrange(inboxKey, 0, -1);
      let foundMessage = null;
      let messageIndex = -1;

      for (let i = 0; i < messages.length; i++) {
        const msg = JSON.parse(messages[i]);
        if (msg.id === messageId) {
          foundMessage = msg;
          messageIndex = i;
          break;
        }
      }

      if (!foundMessage) {
        return res.status(404).json({ success: false, error: "Message not found" });
      }

      const feedback = {
        messageId,
        originalScore: foundMessage.spam?.score || 0,
        originalIsSpam: foundMessage.spam?.isSpam || false,
        userMarkedSpam: isSpam,
        wasCorrect: foundMessage.spam?.isSpam === isSpam,
        timestamp: new Date().toISOString(),
      };

      await redis.lpush(feedbackKey, JSON.stringify(feedback));
      await redis.ltrim(feedbackKey, 0, 99);

      const trainingEmail = `From: ${foundMessage.from}\nSubject: ${foundMessage.subject}\nDate: ${foundMessage.date}\n\n${foundMessage.text || ""}`;
      const trained = await spamService.trainRspamd(trainingEmail, isSpam);

      foundMessage.feedbackSubmitted = true;
      foundMessage.userMarkedSpam = isSpam;
      await redis.lset(inboxKey, messageIndex, JSON.stringify(foundMessage));

      res.json({ success: true, trained, wasCorrect: feedback.wasCorrect });
    } catch (error) {
      console.error("Error processing feedback:", error);
      res.status(500).json({ success: false, error: "Failed to process feedback" });
    }
  };

  const getSpamStats = async (req, res) => {
    try {
      const email = req.params.email.toLowerCase();
      const feedbackKey = `feedback:${email}`;

      const feedbacks = await redis.lrange(feedbackKey, 0, -1);
      const parsed = feedbacks.map((f) => JSON.parse(f));

      const stats = {
        totalFeedbacks: parsed.length,
        correct: parsed.filter((f) => f.wasCorrect).length,
        incorrect: parsed.filter((f) => !f.wasCorrect).length,
        accuracy:
          parsed.length > 0
            ? ((parsed.filter((f) => f.wasCorrect).length / parsed.length) * 100).toFixed(1)
            : 0,
      };

      res.json({ success: true, stats });
    } catch (error) {
      console.error("Error getting spam stats:", error);
      res.status(500).json({ success: false, error: "Failed to get stats" });
    }
  };

  const lockEmail = async (req, res) => {
    try {
      const { email, pin } = req.body;
      const emailLower = (email || "").toLowerCase().trim();

      if (!emailLower || !/^[a-z0-9._-]+@[a-z0-9._-]+\.[a-z]{2,}$/.test(emailLower)) {
        return res.status(400).json({ success: false, error: "Invalid email address" });
      }
      if (!pin || !/^\d{6}$/.test(pin)) {
        return res.status(400).json({ success: false, error: "PIN must be exactly 6 digits" });
      }

      const emailExists = await redis.exists(`email:${emailLower}`);
      if (!emailExists) {
        return res.status(404).json({ success: false, error: "Email not found" });
      }

      const alreadyLocked = await redis.exists(`lock:${emailLower}`);
      if (alreadyLocked) {
        return res.status(409).json({ success: false, error: "This email is already locked" });
      }

      const salt = crypto.randomBytes(16).toString("hex");
      const pinHash = crypto.createHash("sha256").update(salt + pin).digest("hex");
      const unlockToken = crypto.randomBytes(32).toString("hex");

      const lockData = JSON.stringify({ pinHash, salt, lockedAt: new Date().toISOString() });
      const unlockData = JSON.stringify({ token: unlockToken });

      const emailTtl = await redis.ttl(`email:${emailLower}`);
      if (emailTtl > 0) {
        await redis.set(`lock:${emailLower}`, lockData, "EX", emailTtl);
      } else {
        await redis.set(`lock:${emailLower}`, lockData);
      }
      await redis.set(`unlock:${emailLower}`, unlockData, "EX", config.UNLOCK_TOKEN_TTL);

      res.json({ success: true, unlockToken });
    } catch (error) {
      console.error("Error locking email:", error);
      res.status(500).json({ success: false, error: "Failed to lock email" });
    }
  };

  const unlockEmail = async (req, res) => {
    try {
      const { email, pin } = req.body;
      const emailLower = (email || "").toLowerCase().trim();

      if (!emailLower || !pin || !/^\d{6}$/.test(pin)) {
        return res.status(400).json({ success: false, error: "Invalid request" });
      }

      const lockDataStr = await redis.get(`lock:${emailLower}`);
      if (!lockDataStr) {
        return res.status(400).json({ success: false, error: "This email is not locked" });
      }

      const lockData = JSON.parse(lockDataStr);
      const pinHash = crypto.createHash("sha256").update(lockData.salt + pin).digest("hex");

      if (pinHash !== lockData.pinHash) {
        return res.status(401).json({ success: false, error: "Incorrect PIN" });
      }

      await redis.del(`pinattempts:${emailLower}`);

      const unlockToken = crypto.randomBytes(32).toString("hex");
      const unlockData = JSON.stringify({ token: unlockToken });
      await redis.set(`unlock:${emailLower}`, unlockData, "EX", config.UNLOCK_TOKEN_TTL);

      res.json({ success: true, unlockToken, email: emailLower });
    } catch (error) {
      console.error("Error unlocking email:", error);
      res.status(500).json({ success: false, error: "Failed to unlock email" });
    }
  };

  const verifyUnlock = async (req, res) => {
    try {
      const { email } = req.body;
      const emailLower = (email || "").toLowerCase().trim();

      if (!emailLower) {
        return res.status(400).json({ success: false, error: "Email required" });
      }

      const isLocked = await redis.exists(`lock:${emailLower}`);
      res.json({ success: true, isLocked: !!isLocked });
    } catch (error) {
      console.error("Error verifying unlock:", error);
      res.status(500).json({ success: false, error: "Failed to verify" });
    }
  };

  const processIncomingEmail = async ({ emailData, session }) => {
    try {
      const { simpleParser } = require("mailparser");
      const parsed = await simpleParser(emailData);
      const senderIP = session.remoteAddress || "";
      const spamResult = await spamService.checkSpam(emailData, parsed, senderIP);
      const recipients = session.envelope.rcptTo.map((r) => r.address.toLowerCase());

      const emailObj = {
        id: nanoid(10),
        from: parsed.from?.text || "Unknown",
        to: recipients.join(", "),
        subject: parsed.subject || "(No Subject)",
        text: parsed.text || "",
        html: parsed.html || "",
        date: parsed.date?.toISOString() || new Date().toISOString(),
        attachments: (parsed.attachments || []).map((att) => ({
          filename: att.filename,
          contentType: att.contentType,
          size: att.size,
          content: att.content ? att.content.toString("base64") : null,
        })),
        spam: {
          isSpam: spamResult.isSpam,
          score: spamResult.score,
          source: spamResult.source || "unknown",
        },
      };

      for (const recipient of recipients) {
        const inboxKey = `inbox:${recipient}`;
        const emailKey = `email:${recipient}`;

        let wasForwarded = false;
        const emailDataStr = await redis.get(emailKey);
        if (emailDataStr) {
          const emailSettings = JSON.parse(emailDataStr);
          const isSafeToForward = spamResult.score < config.FORWARD_THRESHOLD;

          if (emailSettings.forwardEnabled && emailSettings.forwardTo && isSafeToForward) {
            wasForwarded = await forwardingService.forwardEmail({
              resend,
              config,
              emailObj,
              forwardTo: emailSettings.forwardTo,
            });
          }
        }

        await redis.lpush(inboxKey, JSON.stringify({ ...emailObj, forwarded: wasForwarded }));

        // Notify connected clients about new email
        broadcastToUser(recipient, { type: "new-email", data: { id: emailObj.id, from: emailObj.from, subject: emailObj.subject, date: emailObj.date } });
      }
    } catch (error) {
      throw error;
    }
  };

  return {
    generate,
    checkHandle,
    createCustom,
    getInbox,
    refreshEmail,
    deleteInboxEmail,
    releaseEmail,
    sendEmail,
    getSentEmails,
    getSystemStats,
    recordVisit,
    getActiveHandles,
    getActiveCount,
    getForwarding,
    updateForwarding,
    submitSpamFeedback,
    getSpamStats,
    lockEmail,
    unlockEmail,
    verifyUnlock,
    processIncomingEmail,
  };
}

module.exports = {
  createPublicController,
};
