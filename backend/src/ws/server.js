const { WebSocketServer } = require("ws");
const os = require("os");

function createWebSocketServer(httpServer, { redis, adminPassword, getCpuHistory, getCpuPercentage, listAllRateLimits, broadcastToUser: broadcastUserRef }) {
  const wss = new WebSocketServer({ noServer: true });

  // Track connected clients
  const adminClients = new Set();
  const userClients = new Map(); // email -> Set of clients

  // Broadcast helpers
  function broadcastToAdmin(data) {
    const msg = JSON.stringify(data);
    for (const client of adminClients) {
      if (client.readyState === 1) {
        client.send(msg);
      }
    }
  }

  function broadcastToUser(email, data) {
    const msg = JSON.stringify(data);
    const clients = userClients.get(email);
    if (clients) {
      for (const client of clients) {
        if (client.readyState === 1) {
          client.send(msg);
        }
      }
    }
  }

  // Periodic stats broadcast to admin clients (every 3 seconds)
  const statsInterval = setInterval(async () => {
    if (adminClients.size === 0) return;
    try {
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const cpus = os.cpus();
      const loadAvg = os.loadavg();

      // Count handles
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

      const redisInfo = await redis.info();
      const usedMemoryMatch = redisInfo.match(/used_memory_human:(\S+)/);
      const connectedClientsMatch = redisInfo.match(/connected_clients:(\d+)/);

      broadcastToAdmin({
        type: "stats",
        data: {
          system: {
            cpu: {
              cores: cpus.length,
              loadAvg: loadAvg[0].toFixed(2),
              percentage: parseFloat(getCpuPercentage().toFixed(1)),
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
            clients: connectedClientsMatch ? parseInt(connectedClientsMatch[1], 0) : 0,
          },
          rateLimiting: {
            activeKeys: 0, // Will be updated by separate rate-limits broadcast
          },
          config: {
            emailDomain: process.env.EMAIL_DOMAIN || "stepmail.tech",
            defaultTTL: parseInt(process.env.EMAIL_TTL, 10) || 600,
            spamThreshold: 5,
          },
          timestamp: new Date().toISOString(),
        },
      });

      // Also broadcast CPU history
      broadcastToAdmin({
        type: "cpu-history",
        data: getCpuHistory(),
      });
    } catch (e) {
      // Ignore broadcast errors
    }
  }, 3000);

  // Periodic rate limit broadcast to admin clients (every 5 seconds)
  const rateLimitInterval = setInterval(async () => {
    if (adminClients.size === 0) return;
    try {
      const limits = await listAllRateLimits();
      broadcastToAdmin({
        type: "rate-limits",
        data: { limits },
      });
    } catch (e) {
      // Ignore
    }
  }, 5000);

  wss.on("connection", (ws, req) => {
    // Extract auth info from URL query params
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token");
    const email = url.searchParams.get("email");

    if (token === adminPassword) {
      // Admin client
      adminClients.add(ws);

      // Send initial data immediately
      ws.send(JSON.stringify({
        type: "cpu-history",
        data: getCpuHistory(),
      }));

      // Send initial rate limits
      listAllRateLimits().then((limits) => {
        ws.send(JSON.stringify({
          type: "rate-limits",
          data: { limits },
        }));
      }).catch(() => {});

      ws.on("close", () => {
        adminClients.delete(ws);
      });
    } else if (email) {
      // User client - associate with email handle
      if (!userClients.has(email)) {
        userClients.set(email, new Set());
      }
      userClients.get(email).add(ws);

      ws.on("close", () => {
        const clients = userClients.get(email);
        if (clients) {
          clients.delete(ws);
          if (clients.size === 0) {
            userClients.delete(email);
          }
        }
      });
    } else {
      ws.close(4001, "Unauthorized");
    }
  });

  // Hook into HTTP server upgrade
  httpServer.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
    if (pathname === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    }
  });

  function cleanup() {
    clearInterval(statsInterval);
    clearInterval(rateLimitInterval);
  }

  return {
    broadcastToUser,
    cleanup,
  };
}

module.exports = {
  createWebSocketServer,
};
