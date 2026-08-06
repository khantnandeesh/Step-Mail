const DEFAULTS = {
  general: { max: 200, window: 60 },
  create: { max: 15, window: 3600 },
  send: { max: 20, window: 3600 },
};

function createRateLimiters(redis) {
  function getClientIP(req) {
    return (
      req.ip ||
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown"
    );
  }

  async function checkRateLimit(key, maxRequests, windowSeconds) {
    const current = await redis.incr(key);
    if (current === 1) {
      await redis.expire(key, windowSeconds);
    }
    return current <= maxRequests;
  }

  async function getEffectiveLimit(name) {
    try {
      const configStr = await redis.get("ratelimit:config");
      if (configStr) {
        const config = JSON.parse(configStr);
        if (config[name] && config[name].max > 0 && config[name].window > 0) {
          return config[name];
        }
      }
    } catch (e) {
      // Fall through to defaults
    }
    return DEFAULTS[name];
  }

  const generalRateLimiter = async (req, res, next) => {
    const ip = getClientIP(req);
    const key = `ratelimit:general:${ip}`;
    const limit = await getEffectiveLimit("general");
    const allowed = await checkRateLimit(key, limit.max, limit.window);

    if (!allowed) {
      return res.status(429).json({
        error: "Too many requests. Please slow down.",
        retryAfter: limit.window,
      });
    }
    next();
  };

  const createHandleRateLimiter = async (req, res, next) => {
    const ip = getClientIP(req);
    const key = `ratelimit:create:${ip}`;
    const limit = await getEffectiveLimit("create");
    const allowed = await checkRateLimit(key, limit.max, limit.window);

    if (!allowed) {
      return res.status(429).json({
        error: "Handle creation limit reached. Try again in an hour.",
        retryAfter: limit.window,
      });
    }
    next();
  };

  const sendEmailRateLimiter = async (req, res, next) => {
    const ip = getClientIP(req);
    const key = `ratelimit:send:${ip}`;
    const limit = await getEffectiveLimit("send");
    const allowed = await checkRateLimit(key, limit.max, limit.window);

    if (!allowed) {
      return res.status(429).json({
        error: "Email sending limit reached. Try again later.",
        retryAfter: limit.window,
      });
    }
    next();
  };

  async function getRateLimitStatus(ip) {
    const names = ["general", "create", "send"];
    const result = {};
    for (const name of names) {
      const key = `ratelimit:${name}:${ip}`;
      const limit = await getEffectiveLimit(name);
      const used = parseInt((await redis.get(key)) || "0", 10);
      const ttl = await redis.ttl(key);
      result[name] = {
        used,
        max: limit.max,
        remaining: Math.max(0, limit.max - used),
        resetsIn: ttl > 0 ? ttl : 0,
      };
    }
    return result;
  }

  async function listAllRateLimits() {
    const ips = new Set();
    const keys = [];
    let cursor = "0";

    // Scan all rate limit keys
    do {
      const [nextCursor, foundKeys] = await redis.scan(cursor, "MATCH", "ratelimit:*:*", "COUNT", 100);
      cursor = nextCursor;
      for (const key of foundKeys) {
        keys.push(key);
        // Extract IP: ratelimit:{type}:{ip}
        const parts = key.split(":");
        if (parts.length >= 3) {
          // IP might contain colons (IPv6) — join everything after ratelimit:{type}:
          const ip = parts.slice(2).join(":");
          ips.add(ip);
        }
      }
    } while (cursor !== "0");

    const result = [];
    for (const ip of ips) {
      const entry = { ip, general: null, create: null, send: null };
      for (const name of ["general", "create", "send"]) {
        const key = `ratelimit:${name}:${ip}`;
        const limit = await getEffectiveLimit(name);
        const used = parseInt((await redis.get(key)) || "0", 10);
        const ttl = await redis.ttl(key);
        entry[name] = {
          used,
          max: limit.max,
          remaining: Math.max(0, limit.max - used),
          resetsIn: ttl > 0 ? ttl : 0,
        };
      }
      result.push(entry);
    }

    // Sort by most usage (general limiter)
    result.sort((a, b) => b.general.used - a.general.used);
    return result;
  }

  async function resetRateLimitsForIP(ip) {
    let deleted = 0;
    let cursor = "0";
    do {
      const [nextCursor, foundKeys] = await redis.scan(cursor, "MATCH", `ratelimit:*:${ip}`, "COUNT", 100);
      cursor = nextCursor;
      if (foundKeys.length > 0) {
        await redis.del(...foundKeys);
        deleted += foundKeys.length;
      }
    } while (cursor !== "0");
    return deleted;
  }

  return {
    getClientIP,
    getEffectiveLimit,
    getRateLimitStatus,
    listAllRateLimits,
    resetRateLimitsForIP,
    generalRateLimiter,
    createHandleRateLimiter,
    sendEmailRateLimiter,
  };
}

function createPinAttemptLimiter(redis, config) {
  return async (req, res, next) => {
    const email = (req.body.email || "").toLowerCase().trim();
    if (!email) return next();

    const key = `pinattempts:${email}`;
    const current = await redis.incr(key);
    if (current === 1) {
      await redis.expire(key, config.PIN_ATTEMPT_WINDOW);
    }

    if (current > config.PIN_MAX_ATTEMPTS) {
      return res.status(429).json({
        success: false,
        error: "Too many PIN attempts. Try again in 15 minutes.",
      });
    }
    next();
  };
}

module.exports = {
  createRateLimiters,
  createPinAttemptLimiter,
  DEFAULTS,
};
