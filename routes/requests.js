const express = require("express");
const { z } = require("zod");
const { MoneyRequest, User } = require("../db");
const {
  DAY6_RATE_LIMITS,
  MONEY_REQUEST_EXPIRY_DAYS,
  MONEY_REQUEST_RATE_LIMIT,
} = require("../config");
const { authMiddleware } = require("../auth");
const { rateLimit } = require("../middleware/rateLimit");
const { Day6Error, checkPin, sendDay6Error } = require("../services/day6Service");
const { WalletServiceError } = require("../services/walletService");
const {
  createPaymentIdempotencyKey,
  payMoneyRequest,
} = require("../services/moneyRequestService");

const router = express.Router();
const userIdSchema = z.string().regex(/^[a-f\d]{24}$/i);
const createRequestSchema = z.object({
  to: userIdSchema,
  amount: z.number().int().min(100).max(1000000),
  note: z.string().trim().max(100).optional(),
});
const listQuerySchema = z.object({
  status: z.enum(["PENDING", "PAID", "DECLINED", "CANCELLED", "EXPIRED"]).optional(),
});
const paymentSchema = z.object({
  pin: z.string().regex(/^\d{4}(?:\d{2})?$/),
});
const moneyRateLimit = rateLimit({
  ...DAY6_RATE_LIMITS.money,
  keyFrom: (req) => req.userId,
});
const createRequestRateLimit = rateLimit({
  ...MONEY_REQUEST_RATE_LIMIT,
  keyFrom: (req) => req.userId,
});
let requestIndexesPromise;

async function ensureRequestIndexes() {
  if (!requestIndexesPromise) {
    requestIndexesPromise = MoneyRequest.createIndexes().catch((error) => {
      requestIndexesPromise = undefined;
      throw error;
    });
  }
  await requestIndexesPromise;
}

function isValidObjectId(id) {
  return /^[a-f\d]{24}$/i.test(id);
}

function serializeRequest(request, userId) {
  const requester = request.requesterId;
  const payer = request.payerId;
  const requesterId = requester._id ? requester._id.toString() : requester.toString();
  const payerId = payer._id ? payer._id.toString() : payer.toString();
  const isRequester = requesterId === userId;
  const otherPerson = isRequester ? payer : requester;

  return {
    id: request._id.toString(),
    otherPerson: {
      id: otherPerson._id ? otherPerson._id.toString() : otherPerson.toString(),
      name: otherPerson.firstName
        ? `${otherPerson.firstName} ${otherPerson.lastName}`.trim()
        : undefined,
    },
    amount: request.amount,
    note: request.note || null,
    status: request.status,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  };
}

router.post("/", authMiddleware, createRequestRateLimit, async (req, res) => {
  await ensureRequestIndexes();
  const parsed = createRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      message: "Provide a valid payer ID, an amount between 100 and 1000000 paise, and a note no longer than 100 characters.",
    });
  }

  const payerId = parsed.data.to.toLowerCase();
  if (payerId === req.userId.toLowerCase()) {
    return res.status(400).json({ message: "You cannot request money from yourself" });
  }

  const payer = await User.findById(payerId).select("_id");
  if (!payer) {
    return res.status(404).json({ message: "Payer not found" });
  }

  const now = new Date();
  const pendingCount = await MoneyRequest.countDocuments({
    requesterId: req.userId,
    payerId,
    status: "PENDING",
    expiresAt: { $gt: now },
  });
  if (pendingCount >= 5) {
    return res.status(409).json({
      message: "You already have 5 pending requests to this person",
    });
  }

  const expiresAt = new Date(
    now.getTime() + MONEY_REQUEST_EXPIRY_DAYS * 24 * 60 * 60 * 1000
  );
  const request = await MoneyRequest.create({
    requesterId: req.userId,
    payerId,
    amount: parsed.data.amount,
    note: parsed.data.note,
    status: "PENDING",
    expiresAt,
  });

  return res.status(201).json({
    message: "Request sent",
    request: {
      id: request._id.toString(),
      requesterId: request.requesterId.toString(),
      payerId: request.payerId.toString(),
      amount: request.amount,
      note: request.note || null,
      status: request.status,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
    },
  });
});

async function listRequests(req, res, participantField) {
  await ensureRequestIndexes();
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid request status filter" });
  }

  const filter = { [participantField]: req.userId };
  if (parsed.data.status) filter.status = parsed.data.status;

  const now = new Date();
  await MoneyRequest.updateMany(
    {
      [participantField]: req.userId,
      status: "PENDING",
      expiresAt: { $lte: now },
    },
    { $set: { status: "EXPIRED", decidedAt: now } }
  );

  const requests = await MoneyRequest.find(filter)
    .sort({ createdAt: -1 })
    .limit(20)
    .populate("requesterId", "firstName lastName")
    .populate("payerId", "firstName lastName")
    .lean();

  return res.status(200).json({
    requests: requests.map((request) =>
      serializeRequest(request, req.userId.toString())
    ),
  });
}

router.get("/incoming", authMiddleware, (req, res) =>
  listRequests(req, res, "payerId")
);

router.get("/outgoing", authMiddleware, (req, res) =>
  listRequests(req, res, "requesterId")
);

router.get("/:id", authMiddleware, async (req, res) => {
  await ensureRequestIndexes();
  if (!isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: "Request not found" });
  }

  const request = await MoneyRequest.findOne({
    _id: req.params.id,
    $or: [{ requesterId: req.userId }, { payerId: req.userId }],
  })
    .populate("requesterId", "firstName lastName")
    .populate("payerId", "firstName lastName")
    .lean();

  if (!request) {
    return res.status(404).json({ message: "Request not found" });
  }

  return res.status(200).json({
    request: serializeRequest(request, req.userId.toString()),
  });
});

async function decideRequest(req, res, {
  participantField,
  nextStatus,
  successMessage,
  forbiddenMessage,
}) {
  await ensureRequestIndexes();
  if (!isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: "Request not found" });
  }

  const now = new Date();
  const updated = await MoneyRequest.findOneAndUpdate(
    {
      _id: req.params.id,
      [participantField]: req.userId,
      status: "PENDING",
      expiresAt: { $gt: now },
    },
    { $set: { status: nextStatus, decidedAt: now } },
    { new: true }
  );

  if (updated) {
    return res.status(200).json({
      message: successMessage,
      request: {
        id: updated._id.toString(),
        status: updated.status,
        decidedAt: updated.decidedAt,
      },
    });
  }

  const current = await MoneyRequest.findById(req.params.id).lean();
  if (!current) {
    return res.status(404).json({ message: "Request not found" });
  }

  const requesterId = current.requesterId.toString();
  const payerId = current.payerId.toString();
  if (req.userId !== requesterId && req.userId !== payerId) {
    return res.status(404).json({ message: "Request not found" });
  }

  if (
    (participantField === "payerId" && req.userId !== payerId) ||
    (participantField === "requesterId" && req.userId !== requesterId)
  ) {
    return res.status(403).json({ message: forbiddenMessage });
  }

  if (
    current.status === "EXPIRED" ||
    (current.status === "PENDING" && current.expiresAt <= now)
  ) {
    return res.status(410).json({ message: "This request has expired" });
  }

  return res.status(409).json({
    message: `This request is already ${current.status.toLowerCase()}`,
    status: current.status,
  });
}

router.post("/:id/decline", authMiddleware, (req, res) =>
  decideRequest(req, res, {
    participantField: "payerId",
    nextStatus: "DECLINED",
    successMessage: "Request declined",
    forbiddenMessage: "Only the person asked can decline this request",
  })
);

router.post("/:id/cancel", authMiddleware, (req, res) =>
  decideRequest(req, res, {
    participantField: "requesterId",
    nextStatus: "CANCELLED",
    successMessage: "Request cancelled",
    forbiddenMessage: "Only the requester can cancel this request",
  })
);

router.post("/:id/pay", authMiddleware, moneyRateLimit, async (req, res) => {
  await ensureRequestIndexes();
  const parsed = paymentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Provide a valid 4 or 6 digit payment PIN" });
  }

  const idempotencyHeader = req.get("Idempotency-Key")?.trim();
  if (!idempotencyHeader || idempotencyHeader.length > 200) {
    return res.status(400).json({
      message: "A valid Idempotency-Key header is required (1-200 characters).",
    });
  }

  if (!isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: "Request not found" });
  }

  const request = await MoneyRequest.findById(req.params.id).lean();
  if (!request) {
    return res.status(404).json({ message: "Request not found" });
  }

  const requesterId = request.requesterId.toString();
  const payerId = request.payerId.toString();
  if (req.userId !== requesterId && req.userId !== payerId) {
    return res.status(404).json({ message: "Request not found" });
  }
  if (req.userId === requesterId) {
    return res.status(403).json({
      message: "Only the person asked can pay this request",
    });
  }

  const now = new Date();
  if (
    request.status === "EXPIRED" ||
    (request.status === "PENDING" && request.expiresAt <= now)
  ) {
    return res.status(410).json({ message: "This request has expired" });
  }
  if (!["PENDING", "PAID"].includes(request.status)) {
    return res.status(409).json({
      message: `This request is already ${request.status.toLowerCase()}`,
      status: request.status,
    });
  }

  try {
    await checkPin(req.userId, parsed.data.pin);
    const requestKey = createPaymentIdempotencyKey({
      route: "POST:/api/v1/requests/:id/pay",
      requestId: request._id.toString(),
      key: idempotencyHeader,
    });
    const result = await payMoneyRequest({
      requestId: request._id,
      payerId: request.payerId,
      requesterId: request.requesterId,
      amount: request.amount,
      note: request.note,
      requestKey,
    });

    return res.status(200).json({
      message: "Request paid",
      transactionId: result.transaction._id.toString(),
      balance: result.transaction.fromBalanceAfter,
      replayed: result.replayed,
    });
  } catch (error) {
    if (error instanceof Day6Error && sendDay6Error(res, error)) {
      return;
    }
    if (error instanceof WalletServiceError) {
      return res.status(error.statusCode).json({
        message: error.message,
        code: error.code,
      });
    }
    throw error;
  }
});

module.exports = router;
