const { createHmac, timingSafeEqual } = require("crypto");

function createCheckoutSignature(orderId, paymentId, secret) {
  return createHmac("sha256", secret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
}

function createWebhookSignature(rawBody, secret) {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function verifySignature(expected, supplied) {
  if (
    typeof supplied !== "string" ||
    !/^[a-f\d]{64}$/i.test(supplied) ||
    !/^[a-f\d]{64}$/i.test(expected)
  ) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected, "hex");
  const suppliedBuffer = Buffer.from(supplied, "hex");

  return (
    expectedBuffer.length === suppliedBuffer.length &&
    timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
}

module.exports = {
  createCheckoutSignature,
  createWebhookSignature,
  verifySignature,
};
