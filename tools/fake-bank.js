const http = require("http");
const { randomUUID } = require("crypto");

const PORT = 4000;
const payouts = new Map();

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 16 * 1024) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/payouts") {
    return sendJson(res, 404, { error: "Not found" });
  }

  let payout;
  try {
    payout = await readJson(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }

  if (
    typeof payout.payoutReference !== "string" ||
    !Number.isSafeInteger(payout.amount) ||
    payout.amount <= 0 ||
    typeof payout.accountNumber !== "string" ||
    !/^\d{9,18}$/.test(payout.accountNumber) ||
    typeof payout.ifsc !== "string"
  ) {
    return sendJson(res, 400, { error: "Invalid fake-bank payout request" });
  }

  const scenario = payout.scenario || "SUCCESS";
  let record = payouts.get(payout.payoutReference);
  if (!record) {
    record = { attempts: 0, finalResult: null, pending: false };
    payouts.set(payout.payoutReference, record);
  }

  record.attempts += 1;
  if (record.finalResult) {
    return sendJson(res, 200, record.finalResult);
  }

  if (scenario === "CLOSED_ACCOUNT") {
    record.finalResult = {
      status: "FAILED",
      permanent: true,
      reason: "The fake bank account is closed.",
    };
    return sendJson(res, 200, record.finalResult);
  }

  if (scenario === "TEMPORARY_FAILURE" && record.attempts <= 2) {
    return sendJson(res, 503, {
      status: "RETRY",
      reason: "The fake bank is temporarily unavailable.",
    });
  }

  const succeed = () => {
    record.pending = false;
    record.finalResult = {
      status: "SUCCEEDED",
      bankReference: `fake_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
    };
  };

  if (scenario === "TIMEOUT" && !record.finalResult) {
    if (!record.pending) {
      record.pending = true;
      setTimeout(succeed, 4000);
    }
    await delay(4000);
    if (res.destroyed) {
      return;
    }
  } else {
    succeed();
  }

  return sendJson(res, 200, record.finalResult);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Local fake bank listening on http://127.0.0.1:${PORT}`);
});

server.on("error", (error) => {
  console.error(`Fake bank server error: ${error.message}`);
  process.exitCode = 1;
});
