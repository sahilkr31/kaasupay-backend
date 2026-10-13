

const express = require("express");
const logger = require("../logger");
const { withdrawalQueue } = require("../queues/withdrawalQueue");

const router = express.Router();

// Submit a withdrawal job to the queue
router.post("/withdraw", async (req, res) => {
  const { amount } = req.body;

  logger.info(
    { requestId: req.id },
    "Withdrawal request received"
  );

  try {
    const job = await withdrawalQueue.add("process-withdrawal", {
      requestId: req.id,
      amount
    });

    logger.info(
      {
        requestId: req.id,
        jobId: job.id
      },
      "Withdrawal job added to queue"
    );

    return res.status(202).json({
      message: "Withdrawal queued for processing",
      requestId: req.id,
      jobId: job.id
    });
  } catch (error) {
    logger.error(
      {
        requestId: req.id,
        err: error.message
      },
      "Failed to queue withdrawal"
    );

    return res.status(500).json({
      message: "Failed to queue withdrawal",
      requestId: req.id
    });
  }
});

module.exports = router;
