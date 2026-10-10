
const express = require("express");
const { z } = require("zod");
const bcrypt = require("bcryptjs");
const { randomUUID } = require("crypto");
const { users, wallets } = require("../db");
const jwt = require("jsonwebtoken");

const router = express.Router();

// Validate the signup request body
const signupSchema = z.object({
  firstName: z.string().trim().min(1).max(50),
  lastName: z.string().trim().min(1).max(50),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(6)
});


const signinSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1)
});


// POST /api/v1/user/signup
router.post("/signup", async (req, res) => {
  // 1. Validate the incoming data
  const result = signupSchema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      message: "Invalid signup data",
      errors: result.error.issues.map(issue => ({
        field: issue.path.join("."),
        message: issue.message
      }))
    });
  }

  const { firstName, lastName, email, password } = result.data;

  // 2. Check whether this email already exists
  const existingUser = users.find(user => user.email === email);

  if (existingUser) {
    return res.status(409).json({
      message: "Email already registered"
    });
  }

  // 3. Hash the password before storing it
  const passwordHash = await bcrypt.hash(password, 10);

  // 4. Create the user record
  const userId = randomUUID();

  const newUser = {
    id: userId,
    firstName,
    lastName,
    email,
    passwordHash
  };

  users.push(newUser);

  // 5. Create a wallet with zero paise
  const newWallet = {
    id: randomUUID(),
    userId,
    balance: 0
  };

  wallets.push(newWallet);

  // 6. Return safe account and wallet information
  return res.status(201).json({
    message: "Signup successful",
    user: {
      id: newUser.id,
      firstName: newUser.firstName,
      lastName: newUser.lastName,
      email: newUser.email
    },
    wallet: {
      id: newWallet.id,
      balance: newWallet.balance
    }
  });
});


const { JWT_SECRET } = require("../config");

// POST /api/v1/user/signin
router.post("/signin", async (req, res) => {
  // 1. Validate the incoming data
  const result = signinSchema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      message: "Invalid signin data"
    });
  }

  const { email, password } = result.data;

  // 2. Find the user by normalized email
  const user = users.find(existingUser => existingUser.email === email);

  // Use the same error for an unknown email and a wrong password
  if (!user) {
    return res.status(401).json({
      message: "Invalid email or password"
    });
  }

  // 3. Compare the entered password with the stored hash
  const passwordMatches = await bcrypt.compare(
    password,
    user.passwordHash
  );

  if (!passwordMatches) {
    return res.status(401).json({
      message: "Invalid email or password"
    });
  }

  // 4. Create a JWT that expires in one hour
  const token = jwt.sign(
    { userId: user.id },
    JWT_SECRET,
    { expiresIn: "1h" }
  );

  // 5. Return the token and safe user information
  return res.status(200).json({
    message: "Signin successful",
    token,
    user: {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email
    }
  });
});


module.exports = router;
