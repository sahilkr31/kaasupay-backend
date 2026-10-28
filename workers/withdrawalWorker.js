require("dotenv").config();
const { randomUUID } = require("crypto");
const { Worker } = require("bullmq");
const mongoose = require("mongoose");
const logger = require("../logger");
const { connectDB } = require("../db");
const { getLocalBankUrl } = require("../config");
const { withdrawalQueue } = require("../queues/withdrawalQueue");
const {
  claimOutboxEvent,
  completePayout,
  findDispatchableOutboxEvents,
  getWithdrawalForPayout,
  recoverStaleOutboxEvents,
  reversePermanentFailure,
  schedulePayoutRetry,
} = require("../services/withdrawalService");

const connection = {
  host: "127.0.0.1",
  port: 6379,
};
const MAX_ATTEMPTS = 5;
const BANK_TIMEOUT_MS = 3000;

async function callFakeBank(bankUrl, withdrawal, bankAccount) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BANK_TIMEOUT_MS);

  try {
    const response = await fetch(`${bankUrl}/payouts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        payoutReference: withdrawal.payoutReference,
        amount: withdrawal.amount,
        accountNumber: bankAccount.accountNumber,
        ifsc: bankAccount.ifsc,
        scenario: bankAccount.testScenario,
      }),
    });

    const result = await response.json();
    if (response.status === 202 || result.status === "UNKNOWN") {
      return { status: "UNKNOWN", reason: "Fake bank has not confirmed the payout yet." };
    }
    if (!response.ok) {
      throw new Error(`Fake bank returned HTTP ${response.status}`);
    }
    if (!["SUCCEEDED", "FAILED", "RETRY"].includes(result.status)) {
      throw new Error("Fake bank returned an invalid payout status.");
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

async function processPayout(job, bankUrl) {
  const { outboxEventId, requestId, withdrawalId } = job.data;
  const lockToken = randomUUID();
  const event = await claimOutboxEvent(outboxEventId, lockToken);
  if (!event) {
    logger.info(
      { requestId, withdrawalId, outboxEventId },
      "Withdrawal payout job was already claimed or completed"
    );
    return;
  }

  logger.info(
    {
      requestId,
      withdrawalId,
      outboxEventId,
      attempt: event.attempts,
    },
    "Withdrawal payout job claimed"
  );

  try {
    const payout = await getWithdrawalForPayout(event.withdrawalId);
    logger.info(
      {
        requestId,
        withdrawalId,
        payoutReference: payout.withdrawal.payoutReference,
        amount: payout.withdrawal.amount,
        attempt: event.attempts,
      },
      "Calling local fake bank"
    );

    const result = await callFakeBank(bankUrl, payout.withdrawal, payout.bankAccount);
    if (result.status === "SUCCEEDED") {
      const completed = await completePayout({
        outboxEventId: event._id,
        lockToken,
        bankReference: result.bankReference,
      });
      if (completed) {
        logger.info(
          {
            requestId,
            withdrawalId,
            payoutReference: payout.withdrawal.payoutReference,
            bankReference: result.bankReference,
          },
          "Withdrawal succeeded"
        );
      }
      return;
    }

    if (result.status === "FAILED" && result.permanent === true) {
      const reversed = await reversePermanentFailure({
        outboxEventId: event._id,
        lockToken,
        reason: result.reason || "Fake bank permanently rejected the payout.",
      });
      if (reversed) {
        logger.warn(
          {
            requestId,
            withdrawalId,
            payoutReference: payout.withdrawal.payoutReference,
          },
          "Withdrawal permanently rejected and funds reversed"
        );
      }
      return;
    }

    const outcome = await schedulePayoutRetry({
      outboxEventId: event._id,
      lockToken,
      attempts: event.attempts,
      error: result.reason || "Fake bank returned an unresolved payout result.",
    });
    if (outcome === "NEEDS_REVIEW") {
      logger.error(
        {
          requestId,
          withdrawalId,
          payoutReference: payout.withdrawal.payoutReference,
          attempts: event.attempts,
        },
        "Withdrawal requires manual review; reserved funds were not refunded"
      );
    } else if (outcome === "RETRY") {
      logger.warn(
        {
          requestId,
          withdrawalId,
          payoutReference: payout.withdrawal.payoutReference,
          attempt: event.attempts,
        },
        "Withdrawal payout scheduled for retry"
      );
    }
  } catch (error) {
    const outcome = await schedulePayoutRetry({
      outboxEventId: event._id,
      lockToken,
      attempts: event.attempts,
      error: error.name === "AbortError"
        ? "Fake bank request timed out; payout result is unknown."
        : error.message,
    });

    if (outcome === "NEEDS_REVIEW") {
      logger.error(
        {
          requestId,
          withdrawalId,
          outboxEventId,
          attempts: event.attempts,
          err: error.message,
        },
        "Withdrawal reached maximum attempts and requires review"
      );
    } else if (outcome === "RETRY") {
      logger.warn(
        {
          requestId,
          withdrawalId,
          outboxEventId,
          attempt: event.attempts,
          err: error.message,
        },
        "Withdrawal payout failed temporarily and will retry"
      );
    }
  }
}

async function dispatchOutboxEvents() {
  const recovered = await recoverStaleOutboxEvents();
  if (recovered > 0) {
    logger.warn({ recovered }, "Recovered stale withdrawal outbox locks");
  }

  const events = await findDispatchableOutboxEvents();
  for (const event of events) {
    try {
      await withdrawalQueue.add(
        "process-payout",
        {
          outboxEventId: event._id.toString(),
          withdrawalId: event.withdrawalId.toString(),
          requestId: "outbox-recovery",
        },
        {
          jobId: `payout-${event._id.toString()}`,
          removeOnComplete: true,
          removeOnFail: true,
        }
      );
    } catch (error) {
      logger.error(
        {
          outboxEventId: event._id.toString(),
          withdrawalId: event.withdrawalId.toString(),
          err: error.message,
        },
        "Could not dispatch pending withdrawal outbox event"
      );
    }
  }
}

async function startWorker() {
  const bankUrl = getLocalBankUrl();
  await connectDB();

  const worker = new Worker(
    "withdrawals",
    async (job) => {
      if (job.name === "process-withdrawal") {
        const { requestId, amount } = job.data;
        logger.info(
          { requestId, jobId: job.id, amount },
          "Legacy simulated withdrawal worker started processing"
        );
        throw new Error("Simulated withdrawal failure");
      }

      if (job.name === "process-payout") {
        await processPayout(job, bankUrl);
        return;
      }

      throw new Error(`Unsupported withdrawal job type: ${job.name}`);
    },
    { connection, concurrency: 5 }
  );

  worker.on("failed", (job, error) => {
    logger.error(
      {
        requestId: job?.data?.requestId,
        withdrawalId: job?.data?.withdrawalId,
        jobId: job?.id,
        err: error.message,
      },
      "Withdrawal worker job failed"
    );
  });

  worker.on("ready", () => {
    logger.info("Withdrawal worker is ready");
  });

  worker.on("error", (error) => {
    logger.error({ err: error.message }, "Withdrawal worker error");
  });

  const dispatchTimer = setInterval(() => {
    dispatchOutboxEvents().catch((error) => {
      logger.error({ err: error.message }, "Withdrawal outbox dispatcher failed");
    });
  }, 1000);
  dispatchTimer.unref();
  await dispatchOutboxEvents();

  const shutdown = async () => {
    clearInterval(dispatchTimer);
    await worker.close();
    await withdrawalQueue.close();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

startWorker().catch((error) => {
  logger.error({ err: error.message }, "Failed to start withdrawal worker");
  process.exitCode = 1;
});
