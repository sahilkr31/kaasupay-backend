const { createHash } = require("crypto");
const { RateLimitCounter } = require("../db");

let indexesPromise;

async function ensureIndexes() {
  if (!indexesPromise) {
    indexesPromise = RateLimitCounter.createIndexes().catch((error) => {
      indexesPromise = undefined;
      throw error;
    });
  }
  await indexesPromise;
}

function getFixedWindow(now, windowSeconds) {
  const windowMilliseconds = windowSeconds * 1000;
  const windowStart = Math.floor(now.getTime() / windowMilliseconds) * windowMilliseconds;
  return {
    windowStart,
    windowEnd: windowStart + windowMilliseconds,
  };
}

function createCounterKey(name, key, windowStart) {
  return createHash("sha256")
    .update(`${name}:${windowStart}:${key}`)
    .digest("hex");
}

async function incrementIfBelowLimit(key, max, expiresAt) {
  const filter = { key, count: { $lt: max } };
  const update = {
    $inc: { count: 1 },
    $setOnInsert: { expiresAt },
  };

  try {
    return await RateLimitCounter.findOneAndUpdate(filter, update, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: false,
    }).lean();
  } catch (error) {
    if (error.code !== 11000) {
      throw error;
    }
    return RateLimitCounter.findOneAndUpdate(filter, update, {
      new: true,
      setDefaultsOnInsert: false,
    }).lean();
  }
}

function validatePolicy({ name, max, windowSeconds, keyFrom }) {
  if (
    !name ||
    !Number.isInteger(max) ||
    max < 1 ||
    !Number.isInteger(windowSeconds) ||
    windowSeconds < 1 ||
    typeof keyFrom !== "function"
  ) {
    throw new TypeError("Invalid rate limit configuration.");
  }
}

async function consumePolicy(policy, req, now) {
  const { windowStart, windowEnd } = getFixedWindow(now, policy.windowSeconds);
  const keyValue = String(policy.keyFrom(req));
  const key = createCounterKey(policy.name, keyValue, windowStart);
  const counter = await incrementIfBelowLimit(
    key,
    policy.max,
    new Date(windowEnd)
  );
  return {
    max: policy.max,
    remaining: counter ? Math.max(0, policy.max - counter.count) : 0,
    allowed: Boolean(counter),
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((windowEnd - now.getTime()) / 1000)
    ),
  };
}

function rateLimitGroup(policies) {
  if (!Array.isArray(policies) || policies.length === 0) {
    throw new TypeError("At least one rate limit policy is required.");
  }
  policies.forEach(validatePolicy);

  return async function rateLimitMiddleware(req, res, next) {
    try {
      await ensureIndexes();
      const now = new Date();
      const results = await Promise.all(
        policies.map((policy) => consumePolicy(policy, req, now))
      );
      const blocked = results.filter((result) => !result.allowed);
      const primary = blocked[0] || results[0];
      res.setHeader("X-RateLimit-Limit", String(primary.max));
      res.setHeader("X-RateLimit-Remaining", String(primary.remaining));

      if (blocked.length) {
        const retryAfterSeconds = Math.max(
          ...blocked.map((result) => result.retryAfterSeconds)
        );
        res.setHeader("Retry-After", String(retryAfterSeconds));
        return res.status(429).json({
          message: "Too many requests. Slow down",
          retryAfterSeconds,
        });
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };
}

function rateLimit(policy) {
  return rateLimitGroup([policy]);
}

module.exports = {
  createCounterKey,
  getFixedWindow,
  rateLimit,
  rateLimitGroup,
};
