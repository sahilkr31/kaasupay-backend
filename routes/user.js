
const express = require("express");
const { z } = require("zod");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { User, Wallet } = require("../db");
const { DAY6_RATE_LIMITS, JWT_SECRET } = require("../config");
const { authMiddleware } = require("../auth");
const { rateLimit, rateLimitGroup } = require("../middleware/rateLimit");
const {
  isEasyPin,
} = require("../services/day6Service");

const router = express.Router();
const signupRateLimit = rateLimit({
  ...DAY6_RATE_LIMITS.signupIp,
  keyFrom: (req) => req.ip || "unknown",
});
const signinRateLimit = rateLimitGroup([
  {
    ...DAY6_RATE_LIMITS.signinEmail,
    keyFrom: (req) => {
      const email = req.body?.username;
      return typeof email === "string"
        ? email.trim().toLowerCase()
        : `invalid:${req.ip || "unknown"}`;
    },
  },
  {
    ...DAY6_RATE_LIMITS.signinIp,
    keyFrom: (req) => req.ip || "unknown",
  },
]);
const pinSetupRateLimit = rateLimit({
  ...DAY6_RATE_LIMITS.pinSetup,
  keyFrom: (req) => req.userId,
});
const pinSchema = z.string().regex(/^\d{4}(?:\d{2})?$/);

// Validate signup data
const signupSchema = z.object({
  firstName: z.string().trim().min(1).max(50),
  lastName: z.string().trim().min(1).max(50),
  username: z.string().trim().toLowerCase().email(),
  password: z.string().min(6),
});

// Validate signin data
const signinSchema = z.object({
  username: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

// POST /api/v1/user/signup
router.post("/signup", signupRateLimit, async (req, res) => {
  const result = signupSchema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      error: "Invalid signup data",
    });
  }

  const { firstName, lastName, username, password } = result.data;

  try {
    const passwordHash = await bcrypt.hash(password, 10);

    const user = await User.create({
      firstName,
      lastName,
      username,
      passwordHash,
    });

    const wallet = await Wallet.create({
      userId: user._id,
      balance: 0,
    });

    return res.status(201).json({
      message: "User created successfully",
      user: {
        id: user._id.toString(),
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
      },
      wallet: {
        id: wallet._id.toString(),
        balance: wallet.balance,
      },
    });
  } catch (error) {
    // MongoDB duplicate-key error
    if (error.code === 11000) {
      return res.status(409).json({
        error: "This email is already registered",
      });
    }

    throw error;
  }
});

// POST /api/v1/user/signin
router.post("/signin", signinRateLimit, async (req, res) => {
  const result = signinSchema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      error: "Invalid signin data",
    });
  }

  const { username, password } = result.data;
  const user = await User.findOne({ username });

  if (!user) {
    return res.status(401).json({
      error: "Invalid username or password",
    });
  }

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatches) {
    return res.status(401).json({
      error: "Invalid username or password",
    });
  }

  const token = jwt.sign(
    { userId: user._id.toString(), tv: user.tokenVersion || 0 },
    JWT_SECRET,
    { expiresIn: "1h" }
  );

  return res.status(200).json({
    message: "Signin successful",
    token,
    user: {
      id: user._id.toString(),
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
    },
  });
});

router.post("/pin", authMiddleware, pinSetupRateLimit, async (req, res) => {
  if (typeof req.body?.pin !== "string" || !pinSchema.safeParse(req.body.pin).success) {
    return res.status(400).json({ message: "PIN must be 4 or 6 digits" });
  }
  if (isEasyPin(req.body.pin)) {
    return res.status(400).json({ message: "PIN is too easy to guess" });
  }

  if (typeof req.body?.password !== "string") {
    return res.status(401).json({ message: "Wrong password" });
  }

  const user = await User.findById(req.userId).select("passwordHash +pinHash");
  if (!user || !(await bcrypt.compare(req.body.password, user.passwordHash))) {
    return res.status(401).json({ message: "Wrong password" });
  }

  const pinHash = await bcrypt.hash(req.body.pin, 10);
  const updated = await User.findOneAndUpdate(
    { _id: req.userId, passwordHash: user.passwordHash },
    {
      $set: {
        pinHash,
        pinFailedCount: 0,
        pinLockedUntil: null,
      },
    },
    { new: false }
  ).select("_id");

  if (!updated) {
    return res.status(401).json({ message: "Wrong password" });
  }

  return res.status(200).json({
    message: user.pinHash ? "PIN changed" : "PIN set",
  });
});

router.post("/logout-all", authMiddleware, async (req, res) => {
  const user = await User.findByIdAndUpdate(
    req.userId,
    { $inc: { tokenVersion: 1 } },
    { new: true }
  ).select("_id");

  if (!user) {
    return res.status(401).json({
      message: "Session ended. Please sign in again",
    });
  }

  return res.status(200).json({ message: "Signed out on all devices" });
});

router.put("/", authMiddleware, async (req, res) => {
  const passwordChangeSchema = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(6),
  });
  const parsed = passwordChangeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid password change data" });
  }

  const user = await User.findById(req.userId).select("passwordHash tokenVersion");
  if (!user || !(await bcrypt.compare(parsed.data.currentPassword, user.passwordHash))) {
    return res.status(401).json({ message: "Wrong password" });
  }

  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 10);
  const updated = await User.findOneAndUpdate(
    { _id: req.userId, passwordHash: user.passwordHash },
    { $set: { passwordHash }, $inc: { tokenVersion: 1 } },
    { new: true }
  ).select("tokenVersion");

  if (!updated) {
    return res.status(409).json({ message: "Password changed concurrently. Please retry." });
  }

  const token = jwt.sign(
    { userId: req.userId, tv: updated.tokenVersion || 0 },
    JWT_SECRET,
    { expiresIn: "1h" }
  );
  return res.status(200).json({
    message: "Password changed. Other sessions have been invalidated",
    token,
  });
});

router.get("/me", authMiddleware, async (req, res) => {
  const user = await User.findById(req.userId)
    .select("-passwordHash +pinHash");

  if (!user) {
    return res.status(404).json({
      error: "User not found",
    });
  }

  return res.status(200).json({
    user: {
      id: user._id.toString(),
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      createdAt: user.createdAt,
      hasPin: Boolean(user.pinHash),
    },
  });
});

module.exports = router;
