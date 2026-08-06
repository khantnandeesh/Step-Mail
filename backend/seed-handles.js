#!/usr/bin/env node
/**
 * Seed script to create test email handles for load testing
 * Usage: node seed-handles.js [count]
 * Default: 1000 handles
 */

const Redis = require("ioredis");

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const EMAIL_DOMAIN = process.env.EMAIL_DOMAIN || "mail.nandeesh.dev";
const COUNT = parseInt(process.argv[2]) || 1000;

const redis = new Redis(REDIS_URL);

// Generate random handle
function generateHandle(length = 6) {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Random TTL between 5 minutes and 24 hours (or permanent)
function randomTtl() {
  const isPermanent = Math.random() < 0.15; // 15% permanent
  if (isPermanent) return -1;
  return Math.floor(Math.random() * (86400 - 300) + 300); // 5min to 24h
}

// Random date within last 24 hours
function randomCreatedAt() {
  const now = Date.now();
  const msAgo = Math.floor(Math.random() * 24 * 60 * 60 * 1000);
  return new Date(now - msAgo).toISOString();
}

async function seedHandles() {
  console.log(`🚀 Creating ${COUNT} test email handles...`);
  console.log(`📡 Redis: ${REDIS_URL}`);
  console.log(`📧 Domain: ${EMAIL_DOMAIN}\n`);

  const startTime = Date.now();
  const pipeline = redis.pipeline();
  const handles = [];

  for (let i = 0; i < COUNT; i++) {
    const handle = `test_${generateHandle(8)}`;
    const email = `${handle}@${EMAIL_DOMAIN}`;
    const emailKey = `email:${email}`;
    const ttl = randomTtl();
    const hasForwarding = Math.random() < 0.1; // 10% have forwarding

    const data = {
      email,
      createdAt: randomCreatedAt(),
      forwardEnabled: hasForwarding,
      forwardTo: hasForwarding ? `user${i}@example.com` : undefined,
    };

    if (ttl === -1) {
      // Permanent - no expiry
      pipeline.set(emailKey, JSON.stringify(data));
    } else {
      pipeline.set(emailKey, JSON.stringify(data), "EX", ttl);
    }

    handles.push({ handle, ttl: ttl === -1 ? "permanent" : `${ttl}s` });

    // Progress indicator
    if ((i + 1) % 100 === 0) {
      process.stdout.write(`\r⏳ Created ${i + 1}/${COUNT} handles...`);
    }
  }

  // Execute all commands
  await pipeline.exec();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\n\n✅ Successfully created ${COUNT} handles in ${elapsed}s`);
  console.log(`\n📊 Sample handles:`);
  handles.slice(0, 5).forEach((h) => {
    console.log(`   • test_${h.handle}@${EMAIL_DOMAIN} (TTL: ${h.ttl})`);
  });
  console.log(`   ... and ${COUNT - 5} more\n`);

  // Show stats
  const keys = await redis.keys("email:*");
  const emailKeys = keys.filter(
    (k) => !k.includes(":inbox:") && !k.includes(":sent:")
  );
  console.log(`📈 Total active handles in Redis: ${emailKeys.length}`);

  redis.disconnect();
  process.exit(0);
}

seedHandles().catch((err) => {
  console.error("❌ Error:", err);
  redis.disconnect();
  process.exit(1);
});
