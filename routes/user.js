
const express = require("express");
const { z } = require("zod");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { User, Wallet } = require("../db");
const { JWT_SECRET } = require("../config");

const router = express.Router();

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
router.post("/signup", async (req, res) => {
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
router.post("/signin", async (req, res) => {
  const result = signinSchema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      error: "Invalid signin data",
    });
  }

  const { username, password } = result.data;

  const user = await User.findOne({ username });

  // Use the same response for unknown usernames and wrong passwords
  if (!user) {
    return res.status(401).json({
      error: "Invalid username or password",
    });
  }

  const passwordMatches = await bcrypt.compare(
    password,
    user.passwordHash
  );

  if (!passwordMatches) {
    return res.status(401).json({
      error: "Invalid username or password",
    });
  }

  const token = jwt.sign(
    { userId: user._id.toString() },
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


router.get("/me", require("../auth").authMiddleware, async (req, res) => {
  const user = await User.findById(req.userId)
    .select("-passwordHash");

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
    },
  });
});
module.exports = router;
