const CONFIG = {
  EMAIL_DOMAIN: process.env.EMAIL_DOMAIN || "stepmail.tech",
  REDIS_URL: process.env.REDIS_URL || "redis://localhost:6379",
  API_PORT: parseInt(process.env.API_PORT, 10) || 3001,
  SMTP_PORT: parseInt(process.env.SMTP_PORT, 10) || 25,
  EMAIL_TTL: parseInt(process.env.EMAIL_TTL, 10) || 600,
  INBOX_TTL: parseInt(process.env.INBOX_TTL, 10) || 600,
  RESEND_API_KEY: process.env.RESEND_API_KEY || "",
  RSPAMD_URL: process.env.RSPAMD_URL || "http://localhost:11333",
  OOPSPAM_API_KEY: process.env.OOPSPAM_API_KEY || "",
  SPAM_THRESHOLD: parseFloat(process.env.SPAM_THRESHOLD) || 3.0,
  FORWARD_THRESHOLD: parseFloat(process.env.FORWARD_THRESHOLD) || 1.0,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "stepmail2026",
  TLS_KEY_PATH:
    process.env.TLS_KEY_PATH ||
    "/etc/letsencrypt/live/stepmail.tech/privkey.pem",
  TLS_CERT_PATH:
    process.env.TLS_CERT_PATH ||
    "/etc/letsencrypt/live/stepmail.tech/fullchain.pem",
  UNLOCK_TOKEN_TTL: parseInt(process.env.UNLOCK_TOKEN_TTL, 10) || 86400,
  PIN_MAX_ATTEMPTS: parseInt(process.env.PIN_MAX_ATTEMPTS, 10) || 10,
  PIN_ATTEMPT_WINDOW: parseInt(process.env.PIN_ATTEMPT_WINDOW, 10) || 900,
};

module.exports = CONFIG;
