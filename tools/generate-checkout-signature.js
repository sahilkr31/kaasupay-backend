require("dotenv").config();
const {
  createCheckoutSignature,
} = require("../services/razorpaySignatures");

const [orderId, paymentId] = process.argv.slice(2);
const secret = process.env.RAZORPAY_KEY_SECRET;

if (!secret) {
  console.error("Set RAZORPAY_KEY_SECRET in .env to generate a test signature.");
  process.exit(1);
}

if (!orderId || !paymentId) {
  console.error(
    "Usage: node tools/generate-checkout-signature.js <razorpay-order-id> <razorpay-payment-id>"
  );
  process.exit(1);
}

console.log(createCheckoutSignature(orderId, paymentId, secret));
