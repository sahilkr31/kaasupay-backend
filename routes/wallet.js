
const express = require("express");
const { z } = require("zod");
const Razorpay = require("razorpay");
const { randomUUID } = require("crypto");
const { PaymentOrder, Transaction, User, Wallet } = require("../db");
const {
  DAILY_SPENDING_LIMIT_PAISE,
  DAY6_RATE_LIMITS,
  getRazorpayConfiguration,
} = require("../config");
const { authMiddleware, staffKeyMiddleware } = require("../auth");
const { rateLimit } = require("../middleware/rateLimit");
const {
  checkPin,
  getDailySpend,
  indiaDay,
  nextIndiaMidnight,
  sendDay6Error,
} = require("../services/day6Service");
const {
  WalletServiceError,
  creditTopUp,
  depositToWallet,
  getWalletReconciliation,
  transferWallet,
} = require("../services/walletService");
const {
  createCheckoutSignature,
  verifySignature,
} = require("../services/razorpaySignatures");

const router = express.Router();

const userIdSchema = z.string().regex(/^[a-f\d]{24}$/i);
const amountSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const transferSchema = z.object({
  toUserId: userIdSchema,
  amount: amountSchema,
  pin: z.string().regex(/^\d{4}(?:\d{2})?$/),
  description: z.string().trim().min(1).max(200).optional(),
});

const depositSchema = z.object({
  userId: userIdSchema,
  amount: amountSchema,
  description: z.string().trim().min(1).max(200).optional(),
});

const historyQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const createOrderSchema = z.object({
  amount: z.number().int().min(1000).max(1000000),
});

const checkoutVerificationSchema = z.object({
  razorpay_order_id: z.string().min(1).max(100),
  razorpay_payment_id: z.string().min(1).max(100),
  razorpay_signature: z.string().regex(/^[a-f\d]{64}$/i),
});
const moneyRateLimit = rateLimit({
  ...DAY6_RATE_LIMITS.money,
  keyFrom: (req) => req.userId,
});

function serializeTransaction(transaction, userId) {
  const isSender = transaction.fromUserId?.toString() === userId;

  return {
    id: transaction._id.toString(),
    type: transaction.type,
    direction: isSender ? "OUT" : "IN",
    amount: transaction.amount,
    description: transaction.description,
    balanceAfter: isSender
      ? transaction.fromBalanceAfter
      : transaction.toBalanceAfter,
    counterpartyUserId: isSender
      ? transaction.toUserId?.toString() || null
      : transaction.fromUserId?.toString() || null,
    createdAt: transaction.createdAt,
  };
}

function sendWalletError(res, error) {
  if (!(error instanceof WalletServiceError)) {
    return false;
  }

  res.status(error.statusCode).json({
    error: error.message,
    code: error.code,
  });
  return true;
}

// GET /api/v1/wallet/balance
router.get("/balance", authMiddleware, async (req, res) => {
  const wallet = await Wallet.findOne({ userId: req.userId });

  if (!wallet) {
    return res.status(404).json({
      error: "Wallet not found",
    });
  }

  const rupees = (wallet.balance / 100).toFixed(2);

  return res.status(200).json({
    balance: wallet.balance,
    display: `₹${rupees}`,
  });
});

// POST /api/v1/wallet/add-money/order
router.post("/add-money/order", authMiddleware, async (req, res) => {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Amount must be an integer number of paise between 1000 and 1000000.",
    });
  }

  let razorpayConfig;
  try {
    razorpayConfig = getRazorpayConfiguration();
  } catch (error) {
    return res.status(503).json({ error: error.message });
  }

  const razorpay = new Razorpay({
    key_id: razorpayConfig.RAZORPAY_KEY_ID,
    key_secret: razorpayConfig.RAZORPAY_KEY_SECRET,
  });
  const receipt = randomUUID().replace(/-/g, "").slice(0, 40);
  let order;
  try {
    order = await razorpay.orders.create({
      amount: parsed.data.amount,
      currency: "INR",
      receipt,
    });
  } catch {
    return res.status(502).json({ error: "Razorpay could not create the order." });
  }

  if (
    !order.id ||
    order.amount !== parsed.data.amount ||
    order.currency !== "INR" ||
    order.status !== "created"
  ) {
    return res.status(502).json({
      error: "Razorpay returned an unexpected order response.",
    });
  }

  await PaymentOrder.createIndexes();
  const paymentOrder = await PaymentOrder.create({
    userId: req.userId,
    razorpayOrderId: order.id,
    amount: parsed.data.amount,
    currency: "INR",
    status: "CREATED",
  });

  return res.status(201).json({
    orderId: paymentOrder.razorpayOrderId,
    amount: paymentOrder.amount,
    currency: paymentOrder.currency,
    keyId: razorpayConfig.RAZORPAY_KEY_ID,
  });
});

// POST /api/v1/wallet/add-money/verify
router.post("/add-money/verify", authMiddleware, async (req, res) => {
  const parsed = checkoutVerificationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid Razorpay checkout verification data.",
    });
  }

  let razorpayConfig;
  try {
    razorpayConfig = getRazorpayConfiguration();
  } catch (error) {
    return res.status(503).json({ error: error.message });
  }

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
    parsed.data;
  const paymentOrder = await PaymentOrder.findOne({
    razorpayOrderId: razorpay_order_id,
    userId: req.userId,
  });

  if (!paymentOrder) {
    return res.status(404).json({ error: "Payment order not found." });
  }

  const expectedSignature = createCheckoutSignature(
    razorpay_order_id,
    razorpay_payment_id,
    razorpayConfig.RAZORPAY_KEY_SECRET
  );
  if (!verifySignature(expectedSignature, razorpay_signature)) {
    return res.status(400).json({ error: "Invalid Razorpay checkout signature." });
  }

  const razorpay = new Razorpay({
    key_id: razorpayConfig.RAZORPAY_KEY_ID,
    key_secret: razorpayConfig.RAZORPAY_KEY_SECRET,
  });
  let payment;
  try {
    payment = await razorpay.payments.fetch(razorpay_payment_id);
  } catch {
    return res.status(502).json({ error: "Could not verify the Razorpay payment." });
  }

  if (
    payment.order_id !== paymentOrder.razorpayOrderId ||
    payment.status !== "captured"
  ) {
    return res.status(409).json({
      error: "The Razorpay payment is not captured for this order.",
    });
  }

  try {
    const result = await creditTopUp({
      razorpayOrderId: paymentOrder.razorpayOrderId,
      paymentId: payment.id,
      amount: payment.amount,
      currency: payment.currency,
      paidVia: "CHECKOUT",
      paymentMethod: payment.method,
    });

    return res.status(result.replayed ? 200 : 201).json({
      status: "PAID",
      orderId: result.order.razorpayOrderId,
      transactionId: result.transactionId.toString(),
      replayed: result.replayed,
    });
  } catch (error) {
    if (sendWalletError(res, error)) {
      return;
    }
    throw error;
  }
});

// GET /api/v1/wallet/add-money/orders/:orderId
router.get("/add-money/orders/:orderId", authMiddleware, async (req, res) => {
  const paymentOrder = await PaymentOrder.findOne({
    razorpayOrderId: req.params.orderId,
    userId: req.userId,
  }).lean();

  if (!paymentOrder) {
    return res.status(404).json({ error: "Payment order not found." });
  }

  return res.status(200).json({
    orderId: paymentOrder.razorpayOrderId,
    amount: paymentOrder.amount,
    currency: paymentOrder.currency,
    status: paymentOrder.status,
    paymentId: paymentOrder.paymentId || null,
    paidVia: paymentOrder.paidVia || null,
    transactionId: paymentOrder.transactionId?.toString() || null,
    createdAt: paymentOrder.createdAt,
    updatedAt: paymentOrder.updatedAt,
  });
});

// POST /api/v1/wallet/transfer
router.post("/transfer", authMiddleware, moneyRateLimit, async (req, res) => {
  const parsed = transferSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid transfer data. Provide a recipient user ID and a positive integer amount in paise.",
    });
  }

  const idempotencyKey = req.get("Idempotency-Key")?.trim();
  if (!idempotencyKey || idempotencyKey.length > 200) {
    return res.status(400).json({
      error: "A valid Idempotency-Key header is required (1-200 characters).",
    });
  }

  const toUserId = parsed.data.toUserId.toLowerCase();
  if (toUserId === req.userId.toLowerCase()) {
    return res.status(400).json({
      error: "You cannot transfer money to your own wallet.",
    });
  }

  if (!(await User.exists({ _id: toUserId }))) {
    return res.status(404).json({
      error: "Recipient user not found.",
    });
  }
  if (!(await Wallet.exists({ userId: toUserId }))) {
    return res.status(404).json({
      error: "Recipient wallet not found.",
    });
  }

  try {
    await checkPin(req.userId, parsed.data.pin);
  } catch (error) {
    if (sendDay6Error(res, error)) {
      return;
    }
    throw error;
  }

  const description =
    parsed.data.description || `Transfer to ${toUserId}`;

  try {
    const result = await transferWallet({
      fromUserId: req.userId,
      toUserId,
      amount: parsed.data.amount,
      idempotencyKey,
      description,
    });

    return res.status(200).json({
      transaction: serializeTransaction(result.transaction, req.userId),
      replayed: result.replayed,
    });
  } catch (error) {
    if (sendDay6Error(res, error)) {
      return;
    }
    if (sendWalletError(res, error)) {
      return;
    }
    throw error;
  }
});

// GET /api/v1/wallet/limits
router.get("/limits", authMiddleware, async (req, res) => {
  const now = new Date();
  const day = indiaDay(now);
  const usedToday = await getDailySpend(req.userId, day);
  return res.status(200).json({
    dailyLimit: DAILY_SPENDING_LIMIT_PAISE,
    usedToday,
    leftToday: Math.max(0, DAILY_SPENDING_LIMIT_PAISE - usedToday),
    resetsAt: nextIndiaMidnight(now).toISOString(),
  });
});

// POST /api/v1/wallet/deposit
router.post(
  "/deposit",
  authMiddleware,
  staffKeyMiddleware,
  async (req, res) => {
    const parsed = depositSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid deposit data. Provide a user ID and a positive integer amount in paise.",
      });
    }

    const userId = parsed.data.userId.toLowerCase();
    if (userId === req.userId.toLowerCase()) {
      return res.status(403).json({
        error: "Staff deposits cannot target the authenticated staff member's own wallet.",
      });
    }

    try {
      const transaction = await depositToWallet({
        userId,
        amount: parsed.data.amount,
        description: parsed.data.description || "Staff deposit",
      });

      return res.status(201).json({
        transaction: serializeTransaction(transaction, req.userId),
      });
    } catch (error) {
      if (sendWalletError(res, error)) {
        return;
      }
      throw error;
    }
  }
);

// GET /api/v1/wallet/transactions
router.get("/transactions", authMiddleware, async (req, res) => {
  const parsed = historyQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid pagination. Page must be positive and limit must be between 1 and 100.",
    });
  }

  const { page, limit } = parsed.data;
  const filter = {
    $or: [{ fromUserId: req.userId }, { toUserId: req.userId }],
  };
  const [transactions, total] = await Promise.all([
    Transaction.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Transaction.countDocuments(filter),
  ]);

  return res.status(200).json({
    page,
    limit,
    total,
    transactions: transactions.map((transaction) =>
      serializeTransaction(transaction, req.userId)
    ),
  });
});

// GET /api/v1/wallet/reconciliation
router.get(
  "/reconciliation",
  authMiddleware,
  staffKeyMiddleware,
  async (req, res) => {
    try {
      const reconciliation = await getWalletReconciliation();
      return res.status(200).json(reconciliation);
    } catch (error) {
      if (sendWalletError(res, error)) {
        return;
      }
      throw error;
    }
  }
);

module.exports = router;
