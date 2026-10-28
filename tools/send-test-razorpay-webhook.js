require("dotenv").config();
const {
  createWebhookSignature,
} = require("../services/razorpaySignatures");

const [orderId, paymentId, rawAmount] = process.argv.slice(2);
const keyId = process.env.RAZORPAY_KEY_ID;
const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
const amount = Number(rawAmount);
const target = new URL(
  process.env.TEST_WEBHOOK_URL ||
    "http://127.0.0.1:3000/api/v1/webhooks/razorpay"
);

if (!keyId || !keyId.startsWith("rzp_test_")) {
  console.error("Set a test-mode RAZORPAY_KEY_ID (rzp_test_...) in .env.");
  process.exit(1);
}

if (!secret) {
  console.error("Set RAZORPAY_WEBHOOK_SECRET in .env.");
  process.exit(1);
}

if (!orderId || !paymentId || !Number.isSafeInteger(amount) || amount <= 0) {
  console.error(
    "Usage: node tools/send-test-razorpay-webhook.js <razorpay-order-id> <razorpay-payment-id> <amount-in-paise>"
  );
  process.exit(1);
}

if (
  target.protocol !== "http:" ||
  !["localhost", "127.0.0.1", "::1"].includes(target.hostname)
) {
  console.error("Test webhook helper only sends to a local HTTP server.");
  process.exit(1);
}

async function sendWebhook() {
  const rawBody = JSON.stringify({
    entity: "event",
    account_id: "acc_test_local",
    event: "payment.captured",
    contains: ["payment"],
    payload: {
      payment: {
        entity: {
          id: paymentId,
          entity: "payment",
          amount,
          currency: "INR",
          status: "captured",
          order_id: orderId,
          method: "card",
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  });

  const response = await fetch(target, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Razorpay-Signature": createWebhookSignature(rawBody, secret),
    },
    body: rawBody,
  });
  const responseBody = await response.text();
  console.log(`Webhook response: HTTP ${response.status}`);
  console.log(responseBody);

  if (!response.ok) {
    process.exitCode = 1;
  }
}

sendWebhook().catch((error) => {
  console.error(`Could not send local test webhook: ${error.message}`);
  process.exitCode = 1;
});
