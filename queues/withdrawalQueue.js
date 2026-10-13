
const { Queue } = require("bullmq");

// Connect BullMQ to the local Memurai service
const connection = {
  host: "127.0.0.1",
  port: 6379
};

// Create the withdrawal queue
const withdrawalQueue = new Queue("withdrawals", {
  connection
});

module.exports = { withdrawalQueue };
