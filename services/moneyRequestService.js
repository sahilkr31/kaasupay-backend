const { createHash } = require("crypto");
const { MoneyRequest, Transaction } = require("../db");
const {
  WalletServiceError,
  ensureWalletIndexes,
  transferWalletInTransaction,
  withMongoTransaction,
} = require("./walletService");
const {
  ensureDailySpendCounter,
  indiaDay,
} = require("./day6Service");

function createPaymentIdempotencyKey({ route, requestId, key }) {
  return createHash("sha256")
    .update(`${route}:${requestId}:${key}`)
    .digest("hex");
}

function getPaymentReplay(transaction, {
  requestId,
  requesterId,
  amount,
  description,
}) {
  if (
    transaction.moneyRequestId?.toString() !== requestId ||
    transaction.toUserId?.toString() !== requesterId ||
    transaction.amount !== amount ||
    transaction.description !== description
  ) {
    throw new WalletServiceError(
      "This Idempotency-Key was already used for a different payment.",
      409,
      "IDEMPOTENCY_KEY_REUSED"
    );
  }

  return { transaction, replayed: true };
}

function requestStateError(request, now) {
  if (!request) {
    return new WalletServiceError("Request not found.", 404, "REQUEST_NOT_FOUND");
  }

  if (
    request.status === "EXPIRED" ||
    (request.status === "PENDING" && request.expiresAt <= now)
  ) {
    return new WalletServiceError(
      "This request has expired",
      410,
      "REQUEST_EXPIRED"
    );
  }

  return new WalletServiceError(
    `This request is already ${request.status.toLowerCase()}.`,
    409,
    "REQUEST_ALREADY_DECIDED"
  );
}

async function payMoneyRequest({
  requestId,
  payerId,
  requesterId,
  amount,
  note,
  requestKey,
}) {
  const description = note ? `Request: ${note}` : "Request payment";
  const idempotencyKey = requestKey;
  const request = { requestId, requesterId, amount, description };

  await ensureWalletIndexes();

  const previous = await Transaction.findOne({
    fromUserId: payerId,
    idempotencyKey,
  });
  if (previous) return getPaymentReplay(previous, request);

  const spendDay = indiaDay();
  await ensureDailySpendCounter(payerId, spendDay);

  return withMongoTransaction(async (session) => {
    const existing = await Transaction.findOne({
      fromUserId: payerId,
      idempotencyKey,
    }).session(session);
    if (existing) return getPaymentReplay(existing, request);

    const now = new Date();
    const claimed = await MoneyRequest.findOneAndUpdate(
      {
        _id: requestId,
        requesterId,
        payerId,
        status: "PENDING",
        expiresAt: { $gt: now },
      },
      { $set: { status: "PAID", decidedAt: now } },
      { new: true, session }
    );

    if (!claimed) {
      const current = await MoneyRequest.findById(requestId).session(session).lean();
      throw requestStateError(current, now);
    }

    const result = await transferWalletInTransaction({
      session,
      fromUserId: payerId,
      toUserId: requesterId,
      amount,
      description,
      idempotencyKey,
      spendDay,
      moneyRequestId: requestId,
    });

    claimed.transactionId = result.transaction._id;
    await claimed.save({ session });

    return result;
  });
}

module.exports = {
  createPaymentIdempotencyKey,
  payMoneyRequest,
};
