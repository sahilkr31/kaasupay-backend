

const express = require("express");
const { z } = require("zod");
const logger = require("../logger");
const { BankAccount } = require("../db");
const { authMiddleware } = require("../auth");
const { withdrawalQueue } = require("../queues/withdrawalQueue");
const { WalletServiceError } = require("../services/walletService");
const { DAY6_RATE_LIMITS } = require("../config");
const { rateLimit } = require("../middleware/rateLimit");
const { checkPin, sendDay6Error } = require("../services/day6Service");
const {
  createWithdrawal,
  ensureWithdrawalIndexes,
  getUserWithdrawal,
  listUserWithdrawals,
} = require("../services/withdrawalService");

const router = express.Router();

const bankAccountSchema = z.object({
  accountHolderName: z.string().trim().min(2).max(100),
  accountNumber: z.string().regex(/^\d{9,18}$/),
  ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/),
  testScenario: z.enum([
    "SUCCESS",
    "TEMPORARY_FAILURE",
    "TIMEOUT",
    "CLOSED_ACCOUNT",
  ]).optional(),
});

const withdrawalSchema = z.object({
  bankAccountId: z.string().regex(/^[a-f\d]{24}$/i),
  amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  pin: z.string().regex(/^\d{4}(?:\d{2})?$/),
});
const moneyRateLimit = rateLimit({
  ...DAY6_RATE_LIMITS.money,
  keyFrom: (req) => req.userId,
});

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

function serializeWithdrawal(withdrawal) {
  const account = withdrawal.bankAccountId;
  return {
    id: withdrawal._id.toString(),
    amount: withdrawal.amount,
    status: withdrawal.status,
    payoutReference: withdrawal.payoutReference,
    bankReference: withdrawal.bankReference || null,
    failureReason: withdrawal.failureReason || null,
    bankAccount: account
      ? {
          id: account._id.toString(),
          accountHolderName: account.accountHolderName,
          accountNumber: `****${account.lastFour}`,
          ifsc: account.ifsc,
        }
      : { id: withdrawal.bankAccountId.toString() },
    createdAt: withdrawal.createdAt,
    updatedAt: withdrawal.updatedAt,
    completedAt: withdrawal.completedAt || null,
    reversedAt: withdrawal.reversedAt || null,
  };
}

function sendWithdrawalError(res, error) {
  if (!(error instanceof WalletServiceError)) {
    return false;
  }
  res.status(error.statusCode).json({
    error: error.message,
    code: error.code,
  });
  return true;
}

router.post("/bank-accounts", authMiddleware, async (req, res) => {
  const parsed = bankAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Provide a valid account holder name, 9-18 digit account number, and Indian IFSC code.",
    });
  }

  await ensureWithdrawalIndexes();
  const account = await BankAccount.create({
    userId: req.userId,
    accountHolderName: parsed.data.accountHolderName,
    accountNumber: parsed.data.accountNumber,
    lastFour: parsed.data.accountNumber.slice(-4),
    ifsc: parsed.data.ifsc,
    testScenario: parsed.data.testScenario || "SUCCESS",
  });

  logger.info(
    { requestId: req.id, userId: req.userId, bankAccountId: account._id.toString() },
    "Bank account added"
  );

  return res.status(201).json({
    bankAccount: {
      id: account._id.toString(),
      accountHolderName: account.accountHolderName,
      accountNumber: `****${account.lastFour}`,
      ifsc: account.ifsc,
      createdAt: account.createdAt,
    },
  });
});

router.get("/bank-accounts", authMiddleware, async (req, res) => {
  const accounts = await BankAccount.find({ userId: req.userId })
    .sort({ createdAt: -1 })
    .select("accountHolderName lastFour ifsc createdAt")
    .lean();

  return res.status(200).json({
    bankAccounts: accounts.map((account) => ({
      id: account._id.toString(),
      accountHolderName: account.accountHolderName,
      accountNumber: `****${account.lastFour}`,
      ifsc: account.ifsc,
      createdAt: account.createdAt,
    })),
  });
});

router.post("/withdrawals", authMiddleware, moneyRateLimit, async (req, res) => {
  const parsed = withdrawalSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Provide a bank account ID and a positive integer amount in paise.",
    });
  }

  const idempotencyKey = req.get("Idempotency-Key")?.trim();
  if (!idempotencyKey || idempotencyKey.length > 200) {
    return res.status(400).json({
      error: "A valid Idempotency-Key header is required (1-200 characters).",
    });
  }

  const bankAccountId = parsed.data.bankAccountId.toLowerCase();
  try {
    await checkPin(req.userId, parsed.data.pin);
    const result = await createWithdrawal({
      userId: req.userId,
      bankAccountId,
      amount: parsed.data.amount,
      idempotencyKey,
      requestId: req.id,
    });

    if (!result.replayed) {
      logger.info(
        {
          requestId: req.id,
          withdrawalId: result.withdrawal._id.toString(),
          amount: result.withdrawal.amount,
          outboxEventId: result.outboxEvent._id.toString(),
        },
        "Withdrawal created and funds reserved"
      );

      try {
        const job = await withdrawalQueue.add(
          "process-payout",
          {
            outboxEventId: result.outboxEvent._id.toString(),
            requestId: req.id,
            withdrawalId: result.withdrawal._id.toString(),
          },
          {
            jobId: `payout-${result.outboxEvent._id.toString()}`,
            removeOnComplete: true,
            removeOnFail: true,
          }
        );
        logger.info(
          {
            requestId: req.id,
            withdrawalId: result.withdrawal._id.toString(),
            outboxEventId: result.outboxEvent._id.toString(),
            jobId: job.id,
          },
          "Withdrawal payout job dispatched"
        );
      } catch (error) {
        logger.error(
          {
            requestId: req.id,
            withdrawalId: result.withdrawal._id.toString(),
            outboxEventId: result.outboxEvent._id.toString(),
            err: error.message,
          },
          "Withdrawal remains in outbox after queue dispatch failure"
        );
      }
    } else {
      logger.info(
        {
          requestId: req.id,
          withdrawalId: result.withdrawal._id.toString(),
        },
        "Duplicate withdrawal request replayed"
      );
    }

    return res.status(202).json({
      message: "Withdrawal request accepted for processing.",
      replayed: result.replayed,
      withdrawal: {
        id: result.withdrawal._id.toString(),
        amount: result.withdrawal.amount,
        status: result.withdrawal.status,
        payoutReference: result.withdrawal.payoutReference,
      },
    });
  } catch (error) {
    if (sendDay6Error(res, error)) {
      return;
    }
    if (sendWithdrawalError(res, error)) {
      return;
    }
    throw error;
  }
});

router.get("/withdrawals", authMiddleware, async (req, res) => {
  const parsed = paginationSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Page must be positive and limit must be between 1 and 100.",
    });
  }

  const result = await listUserWithdrawals(req.userId, parsed.data);
  return res.status(200).json({
    page: parsed.data.page,
    limit: parsed.data.limit,
    total: result.total,
    withdrawals: result.withdrawals.map(serializeWithdrawal),
  });
});

router.get("/withdrawals/:id", authMiddleware, async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) {
    return res.status(400).json({ error: "Invalid withdrawal ID." });
  }

  const withdrawal = await getUserWithdrawal(req.userId, req.params.id);
  if (!withdrawal) {
    return res.status(404).json({ error: "Withdrawal not found." });
  }

  return res.status(200).json({
    withdrawal: serializeWithdrawal(withdrawal),
  });
});

router.post("/withdraw", (_req, res) => {
  return res.status(410).json({
    error: "This withdrawal endpoint is retired. Use POST /api/v1/wallet/withdrawals.",
  });
});

module.exports = router;
