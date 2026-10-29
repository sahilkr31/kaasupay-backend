const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DAY6_RATE_LIMITS,
  DAILY_SPENDING_LIMIT_PAISE,
} = require("../config");
const {
  indiaDay,
  isEasyPin,
  nextIndiaMidnight,
} = require("../services/day6Service");
const { DailySpend, RateLimitCounter, Transaction, User } = require("../db");
const {
  createCounterKey,
  getFixedWindow,
} = require("../middleware/rateLimit");

test("India calendar day matches the required UTC boundary examples", () => {
  assert.equal(indiaDay(new Date("2026-10-21T18:29:00.000Z")), "2026-10-21");
  assert.equal(indiaDay(new Date("2026-10-21T18:30:00.000Z")), "2026-10-22");
  assert.equal(indiaDay(new Date("2026-10-22T02:00:00.000Z")), "2026-10-22");
});

test("daily limit resets at midnight India time", () => {
  assert.equal(
    nextIndiaMidnight(new Date("2026-10-21T12:00:00.000Z")).toISOString(),
    "2026-10-21T18:30:00.000Z"
  );
});

test("easy PIN detection rejects common, sequential, and repeated digits", () => {
  for (const pin of ["1234", "0000", "1111", "123456", "654321", "2468"]) {
    assert.equal(isEasyPin(pin), true, `${pin} should be rejected`);
  }
  assert.equal(isEasyPin("5829"), false);
  assert.equal(isEasyPin("005829"), false);
});

test("payment PIN is select-hidden and never part of transaction schema", () => {
  assert.equal(User.schema.path("pinHash").options.select, false);
  assert.equal(User.schema.path("pinFailedCount").options.default, 0);
  assert.equal(User.schema.path("tokenVersion").options.default, 0);
  assert.equal(Transaction.schema.path("pin"), undefined);
  assert.equal(Transaction.schema.path("pinHash"), undefined);
});

test("daily spend and rate-limit counters have required indexes", () => {
  const dailyIndexes = DailySpend.schema.indexes();
  assert.ok(dailyIndexes.some(([keys, options]) =>
    keys.userId === 1 && keys.day === 1 && options.unique === true
  ));

  const rateIndexes = RateLimitCounter.schema.indexes();
  assert.ok(rateIndexes.some(([keys, options]) =>
    keys.key === 1 && options.unique === true
  ));
  assert.ok(rateIndexes.some(([keys, options]) =>
    keys.expiresAt === 1 && options.expireAfterSeconds === 0
  ));
});

test("configured Day 6 limits match the assignment", () => {
  assert.equal(DAILY_SPENDING_LIMIT_PAISE, 1000000);
  assert.deepEqual(DAY6_RATE_LIMITS.signinEmail, {
    name: "signin-email",
    max: 5,
    windowSeconds: 60,
  });
  assert.deepEqual(DAY6_RATE_LIMITS.signinIp, {
    name: "signin-ip",
    max: 20,
    windowSeconds: 60,
  });
  assert.deepEqual(DAY6_RATE_LIMITS.signupIp, {
    name: "signup-ip",
    max: 10,
    windowSeconds: 3600,
  });
  assert.deepEqual(DAY6_RATE_LIMITS.pinSetup, {
    name: "pin-setup",
    max: 5,
    windowSeconds: 3600,
  });
  assert.deepEqual(DAY6_RATE_LIMITS.money, {
    name: "money",
    max: 10,
    windowSeconds: 60,
  });
});

test("fixed-window keys are stable within a window and do not store source identifiers", () => {
  const first = getFixedWindow(new Date("2026-10-21T12:00:01.000Z"), 60);
  const second = getFixedWindow(new Date("2026-10-21T12:00:59.000Z"), 60);
  assert.equal(first.windowStart, second.windowStart);
  assert.equal(first.windowEnd, second.windowEnd);

  const email = "private-user@example.test";
  const key = createCounterKey("signin-email", email, first.windowStart);
  assert.equal(key.includes(email), false);
  assert.match(key, /^[a-f\d]{64}$/);
});
