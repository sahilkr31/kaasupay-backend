const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const withdrawalRoutes = require("../routes/withdrawal");
const { withdrawalQueue } = require("../queues/withdrawalQueue");

test("legacy withdrawal endpoint is retired without queuing a withdrawal", async (t) => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/wallet", withdrawalRoutes);

  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const originalAdd = withdrawalQueue.add;
  let queueCalled = false;
  withdrawalQueue.add = async () => {
    queueCalled = true;
    throw new Error("Legacy withdrawal must not enqueue work");
  };

  t.after(async () => {
    withdrawalQueue.add = originalAdd;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await withdrawalQueue.close();
  });

  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/v1/wallet/withdraw`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: 100 }),
    }
  );

  assert.equal(response.status, 410);
  assert.match((await response.json()).error, /retired/i);
  assert.equal(queueCalled, false);
});
