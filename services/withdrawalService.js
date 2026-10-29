const { randomUUID } = require("crypto");
const {
  BankAccount,
  LedgerEntry,
  OutboxEvent,
  Transaction,
  Wallet,
  Withdrawal,
} = require("../db");
const {
  WalletServiceError,
  withMongoTransaction,
} = require("./walletService");
const {
  consumeDailySpend,
  ensureDailySpendCounter,
  indiaDay,
} = require("./day6Service");

const MAX_BALANCE = Number.MAX_SAFE_INTEGER;
let withdrawalIndexesPromise;

async function ensureWithdrawalIndexes() {
  if (!withdrawalIndexesPromise) {
    withdrawalIndexesPromise = Promise.all([
      BankAccount.createIndexes(),
      Withdrawal.createIndexes(),
      OutboxEvent.createIndexes(),
      Transaction.createIndexes(),
      LedgerEntry.createIndexes(),
    ]).catch((error) => {
      withdrawalIndexesPromise = undefined;
      throw error;
    });
  }
  await withdrawalIndexesPromise;
}

function assertSameRequest(existing, { bankAccountId, amount }) {
  if (
    existing.bankAccountId.toString() !== bankAccountId ||
    existing.amount !== amount
  ) {
    throw new WalletServiceError(
      "This Idempotency-Key was already used for a different withdrawal.",
      409,
      "IDEMPOTENCY_KEY_REUSED"
    );
  }
  return { withdrawal: existing, replayed: true };
}

async function createWithdrawal({
  userId,
  bankAccountId,
  amount,
  idempotencyKey,
  requestId,
}) {
  await ensureWithdrawalIndexes();
  const request = { bankAccountId, amount };

  const existing = await Withdrawal.findOne({ userId, idempotencyKey });
  if (existing) {
    return assertSameRequest(existing, request);
  }

  const spendDay = indiaDay();
  await ensureDailySpendCounter(userId, spendDay);

  try {
    return await withMongoTransaction(async (session) => {
      const previous = await Withdrawal.findOne({
        userId,
        idempotencyKey,
      }).session(session);
      if (previous) {
        return assertSameRequest(previous, request);
      }

      const bankAccount = await BankAccount.findOne({
        _id: bankAccountId,
        userId,
      }).session(session);
      if (!bankAccount) {
        throw new WalletServiceError(
          "Bank account not found.",
          404,
          "BANK_ACCOUNT_NOT_FOUND"
        );
      }

      await consumeDailySpend({
        userId,
        amount,
        day: spendDay,
        session,
      });

      const wallet = await Wallet.findOneAndUpdate(
        { userId, balance: { $gte: amount } },
        { $inc: { balance: -amount } },
        { returnDocument: "after", session }
      );
      if (!wallet) {
        const walletExists = await Wallet.exists({ userId }).session(session);
        if (!walletExists) {
          throw new WalletServiceError("Wallet not found.", 404, "WALLET_NOT_FOUND");
        }
        throw new WalletServiceError(
          "Insufficient wallet balance.",
          409,
          "INSUFFICIENT_FUNDS"
        );
      }

      const [transaction] = await Transaction.create(
        [
          {
            type: "WITHDRAWAL",
            fromUserId: userId,
            amount,
            description: `Withdrawal to bank account ending ${bankAccount.lastFour}`,
            fromBalanceAfter: wallet.balance,
          },
        ],
        { session }
      );

      const [withdrawal] = await Withdrawal.create(
        [
          {
            userId,
            bankAccountId,
            amount,
            payoutReference: `kp_${randomUUID().replace(/-/g, "")}`,
            idempotencyKey,
            status: "PENDING",
            requestId,
            transactionId: transaction._id,
          },
        ],
        { session }
      );

      await LedgerEntry.create(
        [
          {
            transactionId: transaction._id,
            userId,
            direction: "DEBIT",
            amount,
            balanceAfter: wallet.balance,
          },
        ],
        { session }
      );

      const [outboxEvent] = await OutboxEvent.create(
        [
          {
            withdrawalId: withdrawal._id,
            status: "PENDING",
            attempts: 0,
            nextAttemptAt: new Date(),
          },
        ],
        { session }
      );

      return { withdrawal, outboxEvent, replayed: false };
    });
  } catch (error) {
    if (error.code === 11000) {
      const duplicate = await Withdrawal.findOne({ userId, idempotencyKey });
      if (duplicate) {
        return assertSameRequest(duplicate, request);
      }
    }
    throw error;
  }
}

async function claimOutboxEvent(outboxEventId, lockToken) {
  return withMongoTransaction(async (session) => {
    const now = new Date();
    const event = await OutboxEvent.findOneAndUpdate(
      {
        _id: outboxEventId,
        status: "PENDING",
        attempts: { $lt: 5 },
        nextAttemptAt: { $lte: now },
      },
      {
        $set: {
          status: "PROCESSING",
          lockToken,
          lockUntil: new Date(now.getTime() + 30000),
        },
        $inc: { attempts: 1 },
      },
      { returnDocument: "after", session }
    );
    if (!event) {
      return null;
    }

    const withdrawal = await Withdrawal.findOneAndUpdate(
      { _id: event.withdrawalId, status: { $in: ["PENDING", "PROCESSING"] } },
      { $set: { status: "PROCESSING" } },
      { returnDocument: "after", session }
    );
    if (!withdrawal) {
      throw new Error(`Could not move withdrawal ${event.withdrawalId} to PROCESSING`);
    }

    return event;
  });
}

async function getWithdrawalForPayout(withdrawalId) {
  const withdrawal = await Withdrawal.findById(withdrawalId);
  if (!withdrawal) {
    throw new Error(`Withdrawal ${withdrawalId} referenced by outbox event was not found`);
  }

  const bankAccount = await BankAccount.findOne({
    _id: withdrawal.bankAccountId,
    userId: withdrawal.userId,
  }).select("+accountNumber");
  if (!bankAccount) {
    throw new Error(`Bank account for withdrawal ${withdrawalId} was not found`);
  }

  return { withdrawal, bankAccount };
}

async function completePayout({ outboxEventId, lockToken, bankReference }) {
  return withMongoTransaction(async (session) => {
    const event = await OutboxEvent.findOne({
      _id: outboxEventId,
      status: "PROCESSING",
      lockToken,
    }).session(session);
    if (!event) {
      return false;
    }

    const withdrawal = await Withdrawal.findOneAndUpdate(
      { _id: event.withdrawalId, status: "PROCESSING" },
      {
        $set: {
          status: "SUCCEEDED",
          bankReference,
          completedAt: new Date(),
        },
      },
      { returnDocument: "after", session }
    );
    if (!withdrawal) {
      if (await Withdrawal.exists({ _id: event.withdrawalId, status: "SUCCEEDED" }).session(session)) {
        event.status = "DONE";
        event.lockToken = undefined;
        event.lockUntil = undefined;
        await event.save({ session });
        return true;
      }
      return false;
    }

    event.status = "DONE";
    event.lockToken = undefined;
    event.lockUntil = undefined;
    await event.save({ session });
    return true;
  });
}

async function reversePermanentFailure({
  outboxEventId,
  lockToken,
  reason,
}) {
  return withMongoTransaction(async (session) => {
    const event = await OutboxEvent.findOne({
      _id: outboxEventId,
      status: "PROCESSING",
      lockToken,
    }).session(session);
    if (!event) {
      return false;
    }

    const withdrawal = await Withdrawal.findById(event.withdrawalId).session(session);
    if (!withdrawal) {
      throw new Error(`Withdrawal ${event.withdrawalId} was not found during reversal`);
    }

    if (withdrawal.status === "REVERSED") {
      event.status = "DONE";
      event.lockToken = undefined;
      event.lockUntil = undefined;
      await event.save({ session });
      return true;
    }
    if (withdrawal.status !== "PROCESSING") {
      return false;
    }

    const wallet = await Wallet.findOneAndUpdate(
      {
        userId: withdrawal.userId,
        balance: { $lte: MAX_BALANCE - withdrawal.amount },
      },
      { $inc: { balance: withdrawal.amount } },
      { returnDocument: "after", session }
    );
    if (!wallet) {
      throw new Error(`Could not refund withdrawal ${withdrawal._id} to its wallet`);
    }

    const [reversal] = await Transaction.create(
      [
        {
          type: "REVERSAL",
          toUserId: withdrawal.userId,
          amount: withdrawal.amount,
          description: `Refund for failed withdrawal ${withdrawal._id}`,
          toBalanceAfter: wallet.balance,
        },
      ],
      { session }
    );

    await LedgerEntry.create(
      [
        {
          transactionId: reversal._id,
          userId: withdrawal.userId,
          direction: "CREDIT",
          amount: withdrawal.amount,
          balanceAfter: wallet.balance,
        },
      ],
      { session }
    );

    withdrawal.status = "REVERSED";
    withdrawal.failureReason = reason.slice(0, 300);
    withdrawal.reversalTransactionId = reversal._id;
    withdrawal.reversedAt = new Date();
    await withdrawal.save({ session });

    event.status = "DONE";
    event.lockToken = undefined;
    event.lockUntil = undefined;
    await event.save({ session });
    return true;
  });
}

async function schedulePayoutRetry({ outboxEventId, lockToken, attempts, error }) {
  return withMongoTransaction(async (session) => {
    const event = await OutboxEvent.findOne({
      _id: outboxEventId,
      status: "PROCESSING",
      lockToken,
    }).session(session);
    if (!event) {
      return "STALE";
    }

    const message = String(error).slice(0, 300);
    event.lastError = message;
    event.lockToken = undefined;
    event.lockUntil = undefined;

    if (attempts >= 5) {
      event.status = "STUCK";
      await Withdrawal.updateOne(
        { _id: event.withdrawalId, status: "PROCESSING" },
        { $set: { status: "NEEDS_REVIEW", failureReason: message } },
        { session }
      );
      await event.save({ session });
      return "NEEDS_REVIEW";
    }

    const baseDelay = Math.min(30000, 1000 * (2 ** (attempts - 1)));
    const jitter = Math.floor(Math.random() * Math.max(1, baseDelay / 2));
    event.status = "PENDING";
    event.nextAttemptAt = new Date(Date.now() + baseDelay + jitter);
    await event.save({ session });
    await Withdrawal.updateOne(
      { _id: event.withdrawalId, status: "PROCESSING" },
      { $set: { status: "PENDING" } },
      { session }
    );
    return "RETRY";
  });
}

async function recoverStaleOutboxEvents() {
  const staleEvents = await OutboxEvent.find({
    status: "PROCESSING",
    lockUntil: { $lte: new Date() },
  })
    .select("_id withdrawalId attempts")
    .limit(100)
    .lean();

  for (const event of staleEvents) {
    await withMongoTransaction(async (session) => {
      const current = await OutboxEvent.findOne({
        _id: event._id,
        status: "PROCESSING",
        lockUntil: { $lte: new Date() },
      }).session(session);
      if (!current) {
        return;
      }

      current.lockToken = undefined;
      current.lockUntil = undefined;
      if (current.attempts >= 5) {
        current.status = "STUCK";
        await Withdrawal.updateOne(
          { _id: current.withdrawalId, status: "PROCESSING" },
          {
            $set: {
              status: "NEEDS_REVIEW",
              failureReason: "Worker stopped during the final payout attempt.",
            },
          },
          { session }
        );
      } else {
        current.status = "PENDING";
        current.nextAttemptAt = new Date();
        await Withdrawal.updateOne(
          { _id: current.withdrawalId, status: "PROCESSING" },
          { $set: { status: "PENDING" } },
          { session }
        );
      }
      await current.save({ session });
    });
  }

  return staleEvents.length;
}

async function findDispatchableOutboxEvents(limit = 100) {
  return OutboxEvent.find({
    status: "PENDING",
    attempts: { $lt: 5 },
    nextAttemptAt: { $lte: new Date() },
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .select("_id withdrawalId")
    .lean();
}

async function listUserWithdrawals(userId, { page, limit }) {
  const filter = { userId };
  const [withdrawals, total] = await Promise.all([
    Withdrawal.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("bankAccountId", "lastFour ifsc accountHolderName")
      .lean(),
    Withdrawal.countDocuments(filter),
  ]);
  return { withdrawals, total };
}

async function getUserWithdrawal(userId, withdrawalId) {
  return Withdrawal.findOne({ _id: withdrawalId, userId })
    .populate("bankAccountId", "lastFour ifsc accountHolderName")
    .lean();
}

module.exports = {
  claimOutboxEvent,
  completePayout,
  createWithdrawal,
  ensureWithdrawalIndexes,
  findDispatchableOutboxEvents,
  getUserWithdrawal,
  getWithdrawalForPayout,
  listUserWithdrawals,
  recoverStaleOutboxEvents,
  reversePermanentFailure,
  schedulePayoutRetry,
};
