const mongoose = require("mongoose");
const {
  LedgerEntry,
  PaymentOrder,
  Transaction,
  User,
  Wallet,
} = require("../db");
const {
  consumeDailySpend,
  ensureDailySpendCounter,
  indiaDay,
} = require("./day6Service");

const MAX_BALANCE = Number.MAX_SAFE_INTEGER;
let walletIndexesPromise;

class WalletServiceError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = "WalletServiceError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

async function ensureWalletIndexes() {
  if (!walletIndexesPromise) {
    walletIndexesPromise = Promise.all([
      Transaction.createIndexes(),
      LedgerEntry.createIndexes(),
      PaymentOrder.createIndexes(),
    ]).catch((error) => {
      walletIndexesPromise = undefined;
      throw error;
    });
  }

  await walletIndexesPromise;
}

function isTransactionsUnsupported(error) {
  return (
    error.code === 20 ||
    error.codeName === "IllegalOperation" ||
    /transactions? (are|is) not supported|transaction numbers are only allowed on a replica set member or mongos/i.test(
      error.message || ""
    )
  );
}

async function withMongoTransaction(operation) {
  const session = await mongoose.startSession();

  try {
    let result;
    await session.withTransaction(async () => {
      result = await operation(session);
    });
    return result;
  } catch (error) {
    if (isTransactionsUnsupported(error)) {
      throw new WalletServiceError(
        "This MongoDB deployment does not support transactions. Use a replica set or MongoDB Atlas.",
        503,
        "TRANSACTIONS_UNSUPPORTED"
      );
    }

    throw error;
  } finally {
    await session.endSession();
  }
}

function sameTransfer(existing, { toUserId, amount, description }) {
  return (
    existing.toUserId.toString() === toUserId &&
    existing.amount === amount &&
    existing.description === description
  );
}

function getIdempotentResult(existing, request) {
  if (!sameTransfer(existing, request)) {
    throw new WalletServiceError(
      "This Idempotency-Key was already used for a different transfer.",
      409,
      "IDEMPOTENCY_KEY_REUSED"
    );
  }

  return { transaction: existing, replayed: true };
}

async function creditTopUp({
  razorpayOrderId,
  paymentId,
  amount,
  currency,
  paidVia,
  paymentMethod,
}) {
  await ensureWalletIndexes();

  return withMongoTransaction(async (session) => {
    const order = await PaymentOrder.findOne({ razorpayOrderId }).session(session);
    if (!order) {
      throw new WalletServiceError("Payment order not found.", 404, "ORDER_NOT_FOUND");
    }

    if (order.amount !== amount || order.currency !== currency) {
      throw new WalletServiceError(
        "Payment amount or currency does not match the saved order.",
        400,
        "PAYMENT_DETAILS_MISMATCH"
      );
    }

    if (order.status === "PAID") {
      if (order.paymentId !== paymentId) {
        throw new WalletServiceError(
          "This order has already been paid with a different payment.",
          409,
          "ORDER_ALREADY_PAID"
        );
      }

      return {
        order,
        transactionId: order.transactionId,
        replayed: true,
      };
    }

    if (order.status !== "CREATED") {
      throw new WalletServiceError("Payment order is not payable.", 409, "ORDER_NOT_PAYABLE");
    }

    const claimedOrder = await PaymentOrder.findOneAndUpdate(
      { _id: order._id, status: "CREATED" },
      {
        $set: {
          status: "PAID",
          paymentId,
          paidVia,
          paymentMethod,
        },
      },
      { new: true, session }
    );

    if (!claimedOrder) {
      throw new WalletServiceError(
        "Payment order is being processed; retry verification shortly.",
        409,
        "ORDER_CLAIM_CONFLICT"
      );
    }

    const wallet = await Wallet.findOneAndUpdate(
      {
        userId: order.userId,
        balance: { $lte: MAX_BALANCE - order.amount },
      },
      { $inc: { balance: order.amount } },
      { new: true, session }
    );

    if (!wallet) {
      const walletExists = await Wallet.exists({ userId: order.userId }).session(session);
      if (!walletExists) {
        throw new WalletServiceError("Wallet not found.", 404, "WALLET_NOT_FOUND");
      }

      throw new WalletServiceError(
        "Wallet balance would exceed the supported maximum.",
        409,
        "BALANCE_LIMIT_EXCEEDED"
      );
    }

    const [transaction] = await Transaction.create(
      [
        {
          type: "TOPUP",
          toUserId: order.userId,
          amount: order.amount,
          description: "Wallet top-up via Razorpay",
          toBalanceAfter: wallet.balance,
        },
      ],
      { session }
    );

    await LedgerEntry.create(
      [
        {
          transactionId: transaction._id,
          userId: order.userId,
          direction: "CREDIT",
          amount: order.amount,
          balanceAfter: wallet.balance,
        },
      ],
      { session }
    );

    claimedOrder.transactionId = transaction._id;
    await claimedOrder.save({ session });

    return {
      order: claimedOrder,
      transactionId: transaction._id,
      replayed: false,
    };
  });
}

async function transferWallet({
  fromUserId,
  toUserId,
  amount,
  idempotencyKey,
  description,
}) {
  const request = { toUserId, amount, description };

  await ensureWalletIndexes();

  const previous = await Transaction.findOne({
    fromUserId,
    idempotencyKey,
  });
  if (previous) {
    return getIdempotentResult(previous, request);
  }

  const spendDay = indiaDay();
  await ensureDailySpendCounter(fromUserId, spendDay);

  try {
    return await withMongoTransaction(async (session) => {
      const existing = await Transaction.findOne({
        fromUserId,
        idempotencyKey,
      }).session(session);

      if (existing) {
        return getIdempotentResult(existing, request);
      }

      return transferWalletInTransaction({
        session,
        fromUserId,
        toUserId,
        amount,
        idempotencyKey,
        description,
        spendDay,
      });
    });
  } catch (error) {
    if (error.code === 11000) {
      const existing = await Transaction.findOne({ fromUserId, idempotencyKey });
      if (existing) {
        return getIdempotentResult(existing, request);
      }
    }

    throw error;
  }
}

async function transferWalletInTransaction({
  session,
  fromUserId,
  toUserId,
  amount,
  idempotencyKey,
  description,
  spendDay = indiaDay(),
  moneyRequestId,
}) {
  const recipient = await User.findById(toUserId).session(session);
  if (!recipient) {
    throw new WalletServiceError("Recipient user not found.", 404, "RECIPIENT_NOT_FOUND");
  }

  const recipientWallet = await Wallet.findOne({ userId: toUserId }).session(session);
  if (!recipientWallet) {
    throw new WalletServiceError("Recipient wallet not found.", 404, "RECIPIENT_WALLET_NOT_FOUND");
  }

  await consumeDailySpend({
    userId: fromUserId,
    amount,
    day: spendDay,
    session,
  });

  const senderWallet = await Wallet.findOneAndUpdate(
    { userId: fromUserId, balance: { $gte: amount } },
    { $inc: { balance: -amount } },
    { new: true, session }
  );

  if (!senderWallet) {
    const walletExists = await Wallet.exists({ userId: fromUserId }).session(session);
    if (!walletExists) {
      throw new WalletServiceError("Wallet not found.", 404, "WALLET_NOT_FOUND");
    }

    throw new WalletServiceError("Insufficient wallet balance.", 409, "INSUFFICIENT_FUNDS");
  }

  const updatedRecipientWallet = await Wallet.findOneAndUpdate(
    {
      userId: toUserId,
      balance: { $lte: MAX_BALANCE - amount },
    },
    { $inc: { balance: amount } },
    { new: true, session }
  );

  if (!updatedRecipientWallet) {
    throw new WalletServiceError(
      "Recipient wallet balance would exceed the supported maximum.",
      409,
      "BALANCE_LIMIT_EXCEEDED"
    );
  }

  const transactionData = {
    type: "TRANSFER",
    fromUserId,
    toUserId,
    amount,
    description,
    idempotencyKey,
    fromBalanceAfter: senderWallet.balance,
    toBalanceAfter: updatedRecipientWallet.balance,
  };
  if (moneyRequestId) transactionData.moneyRequestId = moneyRequestId;

  const [transaction] = await Transaction.create(
    [transactionData],
    { session, ordered: true }
  );

  await LedgerEntry.create(
    [
      {
        transactionId: transaction._id,
        userId: fromUserId,
        direction: "DEBIT",
        amount,
        balanceAfter: senderWallet.balance,
      },
      {
        transactionId: transaction._id,
        userId: toUserId,
        direction: "CREDIT",
        amount,
        balanceAfter: updatedRecipientWallet.balance,
      },
    ],
    { session, ordered: true }
  );

  return { transaction, replayed: false };
}

async function depositToWallet({ userId, amount, description }) {
  await ensureWalletIndexes();

  return withMongoTransaction(async (session) => {
    const user = await User.findById(userId).session(session);
    if (!user) {
      throw new WalletServiceError("User not found.", 404, "USER_NOT_FOUND");
    }

    const wallet = await Wallet.findOneAndUpdate(
      {
        userId,
        balance: { $lte: MAX_BALANCE - amount },
      },
      { $inc: { balance: amount } },
      { new: true, session }
    );

    if (!wallet) {
      const walletExists = await Wallet.exists({ userId }).session(session);
      if (!walletExists) {
        throw new WalletServiceError("Wallet not found.", 404, "WALLET_NOT_FOUND");
      }

      throw new WalletServiceError(
        "Wallet balance would exceed the supported maximum.",
        409,
        "BALANCE_LIMIT_EXCEEDED"
      );
    }

    const [transaction] = await Transaction.create(
      [
        {
          type: "DEPOSIT",
          toUserId: userId,
          amount,
          description,
          toBalanceAfter: wallet.balance,
        },
      ],
      { session }
    );

    await LedgerEntry.create(
      [
        {
          transactionId: transaction._id,
          userId,
          direction: "CREDIT",
          amount,
          balanceAfter: wallet.balance,
        },
      ],
      { session }
    );

    return transaction;
  });
}

async function getWalletReconciliation() {
  return withMongoTransaction(async (session) => {
    const wallets = await Wallet.find({}, { userId: 1, balance: 1 })
      .session(session)
      .lean();
    const ledgerBalances = await LedgerEntry.aggregate([
      {
        $group: {
          _id: "$userId",
          credits: {
            $sum: { $cond: [{ $eq: ["$direction", "CREDIT"] }, "$amount", 0] },
          },
          debits: {
            $sum: { $cond: [{ $eq: ["$direction", "DEBIT"] }, "$amount", 0] },
          },
        },
      },
      {
        $project: {
          userId: "$_id",
          credits: 1,
          debits: 1,
          balance: { $subtract: ["$credits", "$debits"] },
        },
      },
    ]).session(session);

    const walletsByUser = new Map(
      wallets.map((wallet) => [wallet.userId.toString(), wallet.balance])
    );
    const ledgerByUser = new Map(
      ledgerBalances.map((entry) => [entry.userId.toString(), entry])
    );
    const userIds = new Set([...walletsByUser.keys(), ...ledgerByUser.keys()]);
    const discrepancies = [];

    for (const userId of userIds) {
      const walletBalance = walletsByUser.get(userId);
      const ledger = ledgerByUser.get(userId);
      const ledgerBalance = ledger ? ledger.balance : 0;

      if (walletBalance === undefined || walletBalance !== ledgerBalance) {
        discrepancies.push({
          userId,
          walletBalance: walletBalance === undefined ? null : walletBalance,
          ledgerBalance,
          reason: walletBalance === undefined ? "LEDGER_WITHOUT_WALLET" : "BALANCE_MISMATCH",
        });
      }
    }

    const walletTotal = wallets.reduce((total, wallet) => total + wallet.balance, 0);
    const ledgerCredits = ledgerBalances.reduce((total, entry) => total + entry.credits, 0);
    const ledgerDebits = ledgerBalances.reduce((total, entry) => total + entry.debits, 0);
    const ledgerNet = ledgerCredits - ledgerDebits;

    return {
      consistent: discrepancies.length === 0 && walletTotal === ledgerNet,
      walletCount: wallets.length,
      walletTotal,
      ledgerCredits,
      ledgerDebits,
      ledgerNet,
      discrepancies,
    };
  });
}

module.exports = {
  WalletServiceError,
  creditTopUp,
  depositToWallet,
  ensureWalletIndexes,
  getWalletReconciliation,
  transferWallet,
  transferWalletInTransaction,
  withMongoTransaction,
};
