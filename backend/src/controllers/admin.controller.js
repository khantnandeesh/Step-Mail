const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");
const { DEFAULTS } = require("../middlewares/rateLimit");

const MAX_HISTORY = 60;
const cpuHistory = [];

// Accurate CPU usage tracking via /proc/stat deltas
let prevCpuTimes = null;

function getCpuUsageFromProcStat() {
  try {
    const stat = fs.readFileSync("/proc/stat", "utf8");
    const line = stat.split("\n").find((l) => l.startsWith("cpu "));
    if (!line) return null;
    const fields = line.trim().split(/\s+/).slice(1).map(Number);
    // fields: user, nice, system, idle, iowait, irq, softirq, steal
    const total = fields.reduce((a, b) => a + b, 0);
    const idle = fields[3] + (fields[4] || 0); // idle + iowait
    return { total, idle };
  } catch {
    return null;
  }
}

function getCpuPercentage() {
  const curr = getCpuUsageFromProcStat();
  if (!curr) {
    // Fallback: use os.loadavg but cap more reasonably
    const cpus = os.cpus();
    const loadAvg = os.loadavg();
    return Math.min(100, (loadAvg[0] / Math.max(cpus.length, 1)) * 100);
  }

  if (!prevCpuTimes) {
    prevCpuTimes = curr;
    return 0; // First reading has no delta
  }

  const totalDiff = curr.total - prevCpuTimes.total;
  const idleDiff = curr.idle - prevCpuTimes.idle;
  prevCpuTimes = curr;

  if (totalDiff === 0) return 0;
  return ((totalDiff - idleDiff) / totalDiff) * 100;
}

function createAdminController({ config, redis, addLog, getLogs, getClientIP, listAllRateLimits, resetRateLimitsForIP }) {
  const recordCpuHistory = () => {
    const percentage = getCpuPercentage();

    cpuHistory.push({
      timestamp: Date.now(),
      percentage: parseFloat(percentage.toFixed(1)),
    });

    if (cpuHistory.length > MAX_HISTORY) {
      cpuHistory.shift();
    }
  };

  setInterval(recordCpuHistory, 2000);
  recordCpuHistory();

  const getCpuHistory = () => {
    return cpuHistory.slice();
  };

  const authenticate = (req, res) => {
    const { password } = req.body;

    if (password === config.ADMIN_PASSWORD) {
      addLog("info", "Admin login successful", { ip: getClientIP(req) });
      return res.json({ success: true, authenticated: true });
    }

    addLog("error", "Admin login failed", { ip: getClientIP(req) });
    return res.status(401).json({ success: false, error: "Invalid password" });
  };

  const getStats = async (req, res) => {
    try {
      const cpus = os.cpus();
      const loadAvg = os.loadavg();
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const cpuPercentage = getCpuPercentage();

      let handleCount = 0;
      let permanentCount = 0;
      let expiringCount = 0;
      let cursor = "0";

      do {
        const [nextCursor, keys] = await redis.scan(cursor, "MATCH", "email:*@*", "COUNT", 1000);
        const emailKeys = keys.filter((k) => !k.includes(":inbox:") && !k.includes(":sent:"));

        if (emailKeys.length > 0) {
          const pipeline = redis.pipeline();
          emailKeys.forEach((key) => pipeline.ttl(key));
          const ttls = await pipeline.exec();

          ttls.forEach(([, ttl]) => {
            if (ttl !== -2) {
              handleCount += 1;
              if (ttl === -1) permanentCount += 1;
              else expiringCount += 1;
            }
          });
        }

        cursor = nextCursor;
      } while (cursor !== "0");

      let rateLimitedIPs = 0;
      cursor = "0";
      do {
        const [nextCursor, keys] = await redis.scan(cursor, "MATCH", "ratelimit:*", "COUNT", 100);
        rateLimitedIPs += keys.length;
        cursor = nextCursor;
      } while (cursor !== "0");

      const redisInfo = await redis.info();
      const usedMemoryMatch = redisInfo.match(/used_memory_human:(\S+)/);
      const connectedClientsMatch = redisInfo.match(/connected_clients:(\d+)/);
      const totalConnectionsMatch = redisInfo.match(/total_connections_received:(\d+)/);

      res.json({
        success: true,
        system: {
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
          nodeUptime: Math.floor(process.uptime()),
        },
        handles: {
          total: handleCount,
          permanent: permanentCount,
          expiring: expiringCount,
        },
        redis: {
          memory: usedMemoryMatch ? usedMemoryMatch[1] : "N/A",
          clients: connectedClientsMatch ? parseInt(connectedClientsMatch[1], 10) : 0,
          totalConnections: totalConnectionsMatch
            ? parseInt(totalConnectionsMatch[1], 10)
            : 0,
        },
        rateLimiting: {
          activeKeys: rateLimitedIPs,
        },
        config: {
          emailDomain: config.EMAIL_DOMAIN,
          defaultTTL: config.EMAIL_TTL,
          spamThreshold: config.SPAM_THRESHOLD,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("Error getting admin stats:", error);
      res.status(500).json({ success: false, error: "Failed to get stats" });
    }
  };

  const getServiceStatus = async (req, res) => {
    try {
      const status = await redis.get("service:status") || "on";
      res.json({ success: true, status });
    } catch (error) {
      res.status(500).json({ success: false, error: "Failed to get service status" });
    }
  };

  const setServiceStatus = async (req, res) => {
    try {
      const { status } = req.body;
      if (status !== "on" && status !== "off") {
        return res.status(400).json({ success: false, error: "Status must be 'on' or 'off'" });
      }
      await redis.set("service:status", status);
      addLog("info", `Admin set service status to: ${status}`, { ip: getClientIP(req) });
      res.json({ success: true, status });
    } catch (error) {
      res.status(500).json({ success: false, error: "Failed to set service status" });
    }
  };

  const getRateLimitListData = async () => {
    return listAllRateLimits();
  };

  const listRateLimits = async (req, res) => {
    try {
      const limits = await getRateLimitListData();
      if (!res) return limits;
      res.json({ success: true, limits });
    } catch (error) {
      console.error("Error listing rate limits:", error);
      if (!res) throw error;
      res.status(500).json({ success: false, error: "Failed to list rate limits" });
    }
  };

  const resetRateLimits = async (req, res) => {
    try {
      const ip = decodeURIComponent(req.params.ip);
      const deleted = await resetRateLimitsForIP(ip);
      addLog("info", `Admin reset rate limits for IP: ${ip}`, { deletedKeys: deleted, ip: getClientIP(req) });
      res.json({ success: true, deleted });
    } catch (error) {
      console.error("Error resetting rate limits:", error);
      res.status(500).json({ success: false, error: "Failed to reset rate limits" });
    }
  };

  const getRateLimitConfig = async (req, res) => {
    try {
      const configStr = await redis.get("ratelimit:config");
      const current = configStr ? JSON.parse(configStr) : DEFAULTS;
      res.json({ success: true, defaults: DEFAULTS, current });
    } catch (error) {
      res.status(500).json({ success: false, error: "Failed to get rate limit config" });
    }
  };

  const setRateLimitConfig = async (req, res) => {
    try {
      // Get existing config first
      const existingStr = await redis.get("ratelimit:config");
      const existing = existingStr ? JSON.parse(existingStr) : {};

      const { general, create: createLimit, send } = req.body;
      const newConfig = { ...existing }; // preserve existing values

      for (const [name, value] of Object.entries({ general, create: createLimit, send })) {
        if (value && typeof value.max === "number" && typeof value.window === "number") {
          if (value.max > 0 && value.window > 0 && value.max <= 10000 && value.window <= 86400) {
            newConfig[name] = { max: Math.round(value.max), window: Math.round(value.window) };
          }
        }
      }

      await redis.set("ratelimit:config", JSON.stringify(newConfig));
      addLog("info", "Admin updated rate limit config", { config: newConfig, ip: getClientIP(req) });
      res.json({ success: true, config: newConfig });
    } catch (error) {
      res.status(500).json({ success: false, error: "Failed to update rate limit config" });
    }
  };

  const listLogs = (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 100;
    const type = req.query.type;
    const result = getLogs({ type, limit });

    res.json({
      success: true,
      logs: result.logs,
      total: result.total,
    });
  };

  const listHandles = async (req, res) => {
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
      });
      const results = await pipeline.exec();

      const handles = [];
      for (let i = 0; i < emailKeys.length; i++) {
        const ttl = results[i * 2][1];
        const dataStr = results[i * 2 + 1][1];

        if (ttl !== -2 && dataStr) {
          try {
            const data = JSON.parse(dataStr);
            const email = emailKeys[i].replace("email:", "");
            const inboxCount = await redis.llen(`inbox:${email}`);

            handles.push({
              email,
              handle: email.split("@")[0],
              createdAt: data.createdAt,
              ttl: ttl === -1 ? null : ttl,
              isPermanent: ttl === -1,
              hasForwarding: !!data.forwardTo,
              forwardTo: data.forwardTo || null,
              inboxCount,
            });
          } catch (e) {
            // Ignore malformed values.
          }
        }
      }

      res.json({ success: true, handles, cursor: nextCursor, hasMore: nextCursor !== "0" });
    } catch (error) {
      console.error("Error fetching admin handles:", error);
      res.status(500).json({ success: false, error: "Failed to fetch handles" });
    }
  };

  const deleteHandle = async (req, res) => {
    try {
      const email = req.params.email.toLowerCase();
      const deleted = await redis.del(`email:${email}`, `inbox:${email}`, `sent:${email}`);

      addLog("info", `Admin deleted handle: ${email}`, { deletedKeys: deleted });
      res.json({ success: true, deleted });
    } catch (error) {
      console.error("Error deleting handle:", error);
      res.status(500).json({ success: false, error: "Failed to delete handle" });
    }
  };

  const redeploy = async (req, res) => {
    const scriptPath = "/workspace/deploy.sh";
    if (!fs.existsSync(scriptPath)) {
      return res.status(500).json({ success: false, error: "deploy.sh not mounted" });
    }

    addLog("info", "Admin triggered redeploy");

    // Spawn detached so it survives this container being recreated.
    const child = spawn("sh", [scriptPath], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    child.on("error", (err) => {
      console.error("Failed to spawn deploy script:", err.message);
      addLog("error", "Redeploy spawn failed", { error: err.message });
    });

    // Brief wait so a startup failure can be reported synchronously.
    await new Promise((r) => setTimeout(r, 1200));
    res.json({ success: true, message: "Redeploy started", logDir: "/workspace/deploy-logs" });
  };

  return {
    authenticate,
    getStats,
    getCpuHistory,
    getCpuPercentage,
    getServiceStatus,
    setServiceStatus,
    listRateLimits,
    getRateLimitListData,
    resetRateLimits,
    getRateLimitConfig,
    setRateLimitConfig,
    listLogs,
    listHandles,
    deleteHandle,
    redeploy,
  };
}

module.exports = {
  createAdminController,
};
