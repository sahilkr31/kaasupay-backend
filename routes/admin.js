const express = require("express");
const { z } = require("zod");
const { User, Withdrawal } = require("../db");
const { authMiddleware, staffKeyMiddleware } = require("../auth");
const { getWalletReconciliation } = require("../services/walletService");

const router = express.Router();

const querySchema = z.object({
  status: z.enum([
    "PENDING",
    "PROCESSING",
    "SUCCEEDED",
    "FAILED",
    "REVERSED",
    "NEEDS_REVIEW",
  ]).default("NEEDS_REVIEW"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

router.get(
  "/withdrawals",
  authMiddleware,
  staffKeyMiddleware,
  async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid status or pagination parameters.",
      });
    }

    const { status, page, limit } = parsed.data;
    const filter = { status };
    const [withdrawals, total] = await Promise.all([
      Withdrawal.find(filter)
        .sort({ createdAt: 1, _id: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("bankAccountId", "lastFour ifsc accountHolderName")
        .lean(),
      Withdrawal.countDocuments(filter),
    ]);

    return res.status(200).json({
      status,
      page,
      limit,
      total,
      withdrawals: withdrawals.map((withdrawal) => ({
        id: withdrawal._id.toString(),
        userId: withdrawal.userId.toString(),
        amount: withdrawal.amount,
        status: withdrawal.status,
        payoutReference: withdrawal.payoutReference,
        bankReference: withdrawal.bankReference || null,
        failureReason: withdrawal.failureReason || null,
        bankAccount: withdrawal.bankAccountId
          ? {
              id: withdrawal.bankAccountId._id.toString(),
              accountHolderName: withdrawal.bankAccountId.accountHolderName,
              accountNumber: `****${withdrawal.bankAccountId.lastFour}`,
              ifsc: withdrawal.bankAccountId.ifsc,
            }
          : null,
        createdAt: withdrawal.createdAt,
        updatedAt: withdrawal.updatedAt,
      })),
    });
  }
);

router.post(
  "/users/:id/unlock-pin",
  authMiddleware,
  staffKeyMiddleware,
  async (req, res) => {
    if (!/^[a-f\d]{24}$/i.test(req.params.id)) {
      return res.status(400).json({ message: "Invalid user ID" });
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: { pinFailedCount: 0, pinLockedUntil: null } },
      { new: false }
    ).select("_id");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.status(200).json({ message: "PIN unlocked" });
  }
);

router.get("/reconcile", authMiddleware, staffKeyMiddleware, async (req, res) => {
  const reconciliation = await getWalletReconciliation();
  return res.status(200).json({
    ...reconciliation,
    moneyIsConserved: reconciliation.consistent,
    mismatches: reconciliation.discrepancies,
  });
});

module.exports = router;
