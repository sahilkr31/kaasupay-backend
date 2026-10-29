
const bcrypt = require("bcryptjs");
const { DAILY_SPENDING_LIMIT_PAISE } = require("../config");
const { DailySpend, User } = require("../db");

const PIN_LOCK_SECONDS = 15 * 60;
let dailySpendIndexesPromise;

const EASY_PINS = new Set([
  "0123", "1234", "2345", "3456", "4567", "5678", "6789",
  "9876", "8765", "7654", "6543", "5432", "4321", "3210",
  "2580", "0852", "1212", "1122", "1221", "6969",
  "012345", "123456", "234567", "345678", "456789", "987654",
  "876543", "765432", "654321", "543210", "112233", "123123",
  "121212", "1010", "1313", "2468", "1357", "1470", "1590",
  "5683",
]);

class Day6Error extends Error {
  constructor(message, statusCode, code, details = {}) {
    super(message);
    this.name = "Day6Error";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function sendDay6Error(res, error) {
  if (!(error instanceof Day6Error)) return false;

  if (error.details.retryAfterSeconds) {
    res.setHeader("Retry-After", String(error.details.retryAfterSeconds));
  }

  res.status(error.statusCode).json({
    message: error.message,
    ...error.details,
  });

  return true;
}

function isEasyPin(pin) {
  return (
    EASY_PINS.has(pin) ||
    /^(\d)\1+$/.test(pin) ||
    [...pin].every(
      (digit, index) =>
        index === 0 ||
        Number(digit) - Number(pin[index - 1]) === 1
    ) ||
    [...pin].every(
      (digit, index) =>
        index === 0 ||
        Number(digit) - Number(pin[index - 1]) === -1
    )
  );
}

function indiaDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function nextIndiaMidnight(date = new Date()) {
  const [year, month, day] = indiaDay(date).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 18, 30));
}

function pinLockedError(lockedUntil, now = new Date()) {
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000)
  );

  return new Day6Error("PIN locked. Try again later", 423, "PIN_LOCKED", {
    retryAfterSeconds,
  });
}

async function loadPinState(userId) {
  const now = new Date();

  await User.updateOne(
    {
      _id: userId,
      pinLockedUntil: { $type: "date", $lte: now },
    },
    { $set: { pinFailedCount: 0, pinLockedUntil: null } }
  );

  const user = await User.findById(userId)
    .select("+pinHash pinFailedCount pinLockedUntil")
    .lean();

  if (!user) {
    throw new Day6Error("User not found", 401, "USER_NOT_FOUND");
  }

  if (!user.pinHash) {
    throw new Day6Error("Set your payment PIN first", 400, "PIN_NOT_SET");
  }

  if (user.pinLockedUntil && user.pinLockedUntil > now) {
    throw pinLockedError(user.pinLockedUntil, now);
  }

  return { user, now };
}

async function checkPin(userId, pin) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { user, now } = await loadPinState(userId);
    const matches = await bcrypt.compare(pin, user.pinHash);

    if (matches) {
      const reset = await User.findOneAndUpdate(
        {
          _id: userId,
          pinHash: user.pinHash,
          $or: [
            { pinLockedUntil: null },
            { pinLockedUntil: { $lte: now } },
          ],
        },
        { $set: { pinFailedCount: 0, pinLockedUntil: null } },
        { new: true }
      ).select("_id");

      if (reset) return;

      continue;
    }

    const lockedUntil = new Date(
      now.getTime() + PIN_LOCK_SECONDS * 1000
    );

    const updated = await User.findOneAndUpdate(
      {
        _id: userId,
        pinHash: user.pinHash,
        $or: [
          { pinLockedUntil: null },
          { pinLockedUntil: { $lte: now } },
        ],
        $expr: {
          $lt: [{ $ifNull: ["$pinFailedCount", 0] }, 3],
        },
      },
      [
        {
          $set: {
            pinFailedCount: {
              $add: [{ $ifNull: ["$pinFailedCount", 0] }, 1],
            },
          },
        },
        {
          $set: {
            pinLockedUntil: {
              $cond: [
                { $gte: ["$pinFailedCount", 3] },
                lockedUntil,
                null,
              ],
            },
          },
        },
      ],
      { new: true, updatePipeline: true }
    ).select("pinFailedCount pinLockedUntil");

    if (updated) {
      if (updated.pinLockedUntil) {
        throw pinLockedError(updated.pinLockedUntil, now);
      }

      const triesLeft = Math.max(0, 3 - updated.pinFailedCount);

      throw new Day6Error(
        `Wrong PIN. ${triesLeft} tries left`,
        403,
        "WRONG_PIN",
        { triesLeft }
      );
    }

    const current = await User.findById(userId)
      .select("+pinHash pinFailedCount pinLockedUntil")
      .lean();

    if (current?.pinLockedUntil && current.pinLockedUntil > new Date()) {
      throw pinLockedError(current.pinLockedUntil);
    }

    if (current?.pinHash !== user.pinHash) {
      continue;
    }
  }

  throw new Day6Error(
    "PIN changed while it was being verified. Please retry.",
    409,
    "PIN_CHANGED"
  );
}

async function ensureDailySpendCounter(userId, day = indiaDay()) {
  if (!dailySpendIndexesPromise) {
    dailySpendIndexesPromise = DailySpend.createIndexes().catch((error) => {
      dailySpendIndexesPromise = undefined;
      throw error;
    });
  }

  await dailySpendIndexesPromise;

  try {
    await DailySpend.updateOne(
      { userId, day },
      { $setOnInsert: { spent: 0 } },
      { upsert: true }
    );
  } catch (error) {
    if (error.code !== 11000) throw error;

    const counterExists = await DailySpend.exists({ userId, day });
    if (!counterExists) throw error;
  }

  return day;
}

async function consumeDailySpend({ userId, amount, day, session }) {
  const counter = await DailySpend.findOneAndUpdate(
    {
      userId,
      day,
      spent: { $lte: DAILY_SPENDING_LIMIT_PAISE - amount },
    },
    { $inc: { spent: amount } },
    { new: true, session }
  );

  if (counter) return counter.spent;

  const current = await DailySpend.findOne({ userId, day })
    .session(session)
    .lean();

  if (!current) {
    throw new Error("Daily spend counter was not initialized.");
  }

  throw new Day6Error("Daily limit reached", 400, "DAILY_LIMIT_REACHED", {
    leftToday: Math.max(0, DAILY_SPENDING_LIMIT_PAISE - current.spent),
  });
}

async function getDailySpend(userId, day = indiaDay()) {
  const counter = await DailySpend.findOne({ userId, day }).lean();
  return counter?.spent || 0;
}

module.exports = {
  Day6Error,
  PIN_LOCK_SECONDS,
  checkPin,
  consumeDailySpend,
  ensureDailySpendCounter,
  getDailySpend,
  indiaDay,
  isEasyPin,
  nextIndiaMidnight,
  sendDay6Error,
};
