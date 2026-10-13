

const { Worker } = require("bullmq");
const logger = require("../logger");

// Connect the worker to the same Redis-compatible service
const connection = {
  host: "127.0.0.1",
  port: 6379
};

// Process withdrawal jobs from the queue
const worker = new Worker(
  "withdrawals",
  async (job) => {
    const { requestId, amount } = job.data;

    logger.info(
      {
        requestId,
        jobId: job.id,
        amount
      },
      "Withdrawal worker started processing"
    );

    // Simulate a withdrawal failure for the logging demonstration
    throw new Error("Simulated withdrawal failure");
  },
  { connection }
);

// Log job failures with the same request ID
worker.on("failed", (job, error) => {
  logger.error(
    {
      requestId: job?.data?.requestId,
      jobId: job?.id,
      err: error.message
    },
    "Withdrawal worker failed"
  );
});

// Report worker startup
worker.on("ready", () => {
  logger.info("Withdrawal worker is ready");
});

worker.on("error", (error) => {
  logger.error({ err: error.message }, "Withdrawal worker error");
});
