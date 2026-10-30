
const mongoose = require("mongoose");
const { MONGO_URL, assertRequiredConfig } = require("./config");
let connectionPromise;

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    firstName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 50,
    },
    lastName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 50,
    },
    passwordHash: {
      type: String,
      required: true,
    },
    pinHash: {
      type: String,
      default: null,
      select: false,
    },
    pinFailedCount: {
      type: Number,
      default: 0,
      min: 0,
      max: 3,
      validate: Number.isInteger,
    },
    pinLockedUntil: {
      type: Date,
      default: null,
    },
    tokenVersion: {
      type: Number,
      default: 0,
      min: 0,
      validate: Number.isInteger,
    },
  },
  { timestamps: true }
);

const walletSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    balance: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: "Balance must be an integer number of paise",
      },
    },
  },
  { timestamps: true }
);

const transactionSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["TRANSFER", "DEPOSIT", "TOPUP", "WITHDRAWAL", "REVERSAL"],
      required: true,
    },
    fromUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    toUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: function requiresRecipient() {
        return this.type !== "WITHDRAWAL";
      },
    },
    amount: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isSafeInteger,
        message: "Transaction amount must be a positive integer number of paise",
      },
    },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    idempotencyKey: {
      type: String,
      trim: true,
      maxlength: 200,
    },
    moneyRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MoneyRequest",
    },
    fromBalanceAfter: {
      type: Number,
      min: 0,
      validate: {
        validator: (value) => value === undefined || Number.isSafeInteger(value),
        message: "Balance must be a non-negative integer number of paise",
      },
    },
    toBalanceAfter: {
      type: Number,
      required: function requiresRecipientBalance() {
        return this.type !== "WITHDRAWAL";
      },
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: "Balance must be a non-negative integer number of paise",
      },
    },
  },
  { timestamps: true }
);

transactionSchema.pre("validate", function validateTransaction() {
  if (this.type === "TRANSFER") {
    if (!this.fromUserId) {
      this.invalidate("fromUserId", "A transfer requires a sending user");
    } else if (this.fromUserId.equals(this.toUserId)) {
      this.invalidate("toUserId", "A transfer must have different sender and recipient");
    }

    if (!this.idempotencyKey) {
      this.invalidate("idempotencyKey", "A transfer requires an idempotency key");
    }

    if (this.fromBalanceAfter === undefined) {
      this.invalidate("fromBalanceAfter", "A transfer requires the sender balance after the transaction");
    }
  } else if (this.type === "WITHDRAWAL") {
    if (!this.fromUserId) {
      this.invalidate("fromUserId", "A withdrawal requires a sending user");
    }
    if (this.toUserId) {
      this.invalidate("toUserId", "A withdrawal must not have a wallet recipient");
    }
    if (this.fromBalanceAfter === undefined) {
      this.invalidate("fromBalanceAfter", "A withdrawal requires the sender balance after the transaction");
    }
  } else if (this.fromUserId) {
    this.invalidate("fromUserId", "A deposit must not have a sending user");
  }
});

transactionSchema.index(
  { fromUserId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string" } },
  }
);
transactionSchema.index({ fromUserId: 1, createdAt: -1 });
transactionSchema.index({ toUserId: 1, createdAt: -1 });
transactionSchema.index({ moneyRequestId: 1 }, { unique: true, sparse: true });

const ledgerEntrySchema = new mongoose.Schema(
  {
    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    direction: {
      type: String,
      enum: ["DEBIT", "CREDIT"],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isSafeInteger,
        message: "Ledger amount must be a positive integer number of paise",
      },
    },
    balanceAfter: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: "Balance must be a non-negative integer number of paise",
      },
    },
  },
  { timestamps: true }
);

ledgerEntrySchema.index({ transactionId: 1, userId: 1 }, { unique: true });
ledgerEntrySchema.index({ userId: 1, createdAt: -1 });

const paymentOrderSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    razorpayOrderId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 1000,
      max: 1000000,
      validate: {
        validator: Number.isSafeInteger,
        message: "Order amount must be an integer number of paise",
      },
    },
    currency: {
      type: String,
      required: true,
      enum: ["INR"],
      default: "INR",
    },
    status: {
      type: String,
      required: true,
      enum: ["CREATED", "PAID", "EXPIRED"],
      default: "CREATED",
    },
    paymentId: {
      type: String,
      trim: true,
      sparse: true,
      unique: true,
    },
    paidVia: {
      type: String,
      enum: ["CHECKOUT", "WEBHOOK"],
    },
    paymentMethod: {
      type: String,
      trim: true,
      maxlength: 50,
    },
    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
    },
  },
  { timestamps: true }
);

paymentOrderSchema.index({ userId: 1, createdAt: -1 });

const bankAccountSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    accountHolderName: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 100,
    },
    accountNumber: {
      type: String,
      required: true,
      select: false,
      match: /^\d{9,18}$/,
    },
    lastFour: {
      type: String,
      required: true,
      match: /^\d{4}$/,
    },
    ifsc: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      match: /^[A-Z]{4}0[A-Z0-9]{6}$/,
    },
    testScenario: {
      type: String,
      enum: ["SUCCESS", "TEMPORARY_FAILURE", "TIMEOUT", "CLOSED_ACCOUNT"],
      default: "SUCCESS",
    },
  },
  { timestamps: true }
);

bankAccountSchema.index({ userId: 1, createdAt: -1 });

const withdrawalSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    bankAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BankAccount",
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isSafeInteger,
        message: "Withdrawal amount must be a positive integer number of paise",
      },
    },
    payoutReference: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
    },
    idempotencyKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    status: {
      type: String,
      required: true,
      enum: ["PENDING", "PROCESSING", "SUCCEEDED", "FAILED", "REVERSED", "NEEDS_REVIEW"],
      default: "PENDING",
    },
    requestId: {
      type: String,
      required: true,
    },
    bankReference: {
      type: String,
      trim: true,
    },
    failureReason: {
      type: String,
      trim: true,
      maxlength: 300,
    },
    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      required: true,
    },
    reversalTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
    },
    completedAt: Date,
    reversedAt: Date,
  },
  { timestamps: true }
);

withdrawalSchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });
withdrawalSchema.index({ userId: 1, createdAt: -1 });

const outboxEventSchema = new mongoose.Schema(
  {
    withdrawalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Withdrawal",
      required: true,
      unique: true,
    },
    type: {
      type: String,
      required: true,
      enum: ["PAYOUT"],
      default: "PAYOUT",
    },
    status: {
      type: String,
      required: true,
      enum: ["PENDING", "PROCESSING", "DONE", "STUCK"],
      default: "PENDING",
    },
    attempts: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      max: 5,
      validate: Number.isInteger,
    },
    nextAttemptAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    lockUntil: Date,
    lockToken: String,
    lastError: {
      type: String,
      maxlength: 300,
    },
  },
  { timestamps: true }
);

outboxEventSchema.index({ status: 1, nextAttemptAt: 1 });
outboxEventSchema.index({ status: 1, lockUntil: 1 });

const dailySpendSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    day: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },
    spent: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: Number.isSafeInteger,
    },
  },
  { timestamps: true }
);
dailySpendSchema.index({ userId: 1, day: 1 }, { unique: true });

const rateLimitCounterSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
    },
    count: {
      type: Number,
      required: true,
      min: 0,
      validate: Number.isInteger,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true }
);
rateLimitCounterSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const moneyRequestSchema = new mongoose.Schema(
  {
    requesterId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    payerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 100,
      max: 1000000,
      validate: {
        validator: Number.isSafeInteger,
        message: "Request amount must be an integer number of paise",
      },
    },
    note: {
      type: String,
      trim: true,
      maxlength: 100,
    },
    status: {
      type: String,
      enum: ["PENDING", "PAID", "DECLINED", "CANCELLED", "EXPIRED"],
      required: true,
      default: "PENDING",
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
    },
    decidedAt: Date,
  },
  { timestamps: true }
);
moneyRequestSchema.index({ payerId: 1, createdAt: -1 });
moneyRequestSchema.index({ payerId: 1, status: 1, createdAt: -1 });
moneyRequestSchema.index({ requesterId: 1, createdAt: -1 });
moneyRequestSchema.index({ requesterId: 1, status: 1, createdAt: -1 });

const User = mongoose.model("User", userSchema);
const Wallet = mongoose.model("Wallet", walletSchema);
const Transaction = mongoose.model("Transaction", transactionSchema);
const LedgerEntry = mongoose.model("LedgerEntry", ledgerEntrySchema);
const PaymentOrder = mongoose.model("PaymentOrder", paymentOrderSchema);
const BankAccount = mongoose.model("BankAccount", bankAccountSchema);
const Withdrawal = mongoose.model("Withdrawal", withdrawalSchema);
const OutboxEvent = mongoose.model("OutboxEvent", outboxEventSchema);
const DailySpend = mongoose.model("DailySpend", dailySpendSchema);
const RateLimitCounter = mongoose.model("RateLimitCounter", rateLimitCounterSchema);
const MoneyRequest = mongoose.model("MoneyRequest", moneyRequestSchema);

async function connectDB() {
  assertRequiredConfig();

  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  if (mongoose.connection.readyState === 0) {
    connectionPromise = undefined;
  }

  if (!connectionPromise) {
    connectionPromise = mongoose
      .connect(MONGO_URL)
      .then((connection) => {
        console.log("Connected to MongoDB");
        return connection;
      })
      .catch((error) => {
        connectionPromise = undefined;
        throw error;
      });
  }

  return connectionPromise;
}

module.exports = {
  connectDB,
  User,
  Wallet,
  Transaction,
  LedgerEntry,
  PaymentOrder,
  BankAccount,
  Withdrawal,
  OutboxEvent,
  DailySpend,
  RateLimitCounter,
  MoneyRequest,
};
