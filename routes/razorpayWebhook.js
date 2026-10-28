const express = require("express");
const { z } = require("zod");
const { PaymentOrder } = require("../db");
const { getRazorpayConfiguration } = require("../config");
const { WalletServiceError, creditTopUp } = require("../services/walletService");
const {
  createWebhookSignature,
  verifySignature,
} = require("../services/razorpaySignatures");

const router = express.Router();

const capturedPaymentSchema = z.object({
  id: z.string().min(1),
  order_id: z.string().min(1),
  amount: z.number().int().positive(),
  currency: z.string().min(1),
  status: z.literal("captured"),
  method: z.string().optional(),
});

router.post(
  "/razorpay",
  express.raw({ type: "application/json", limit: "100kb", inflate: false }),
  async (req, res) => {
    let razorpayConfig;
    try {
      razorpayConfig = getRazorpayConfiguration([
        "RAZORPAY_KEY_ID",
        "RAZORPAY_WEBHOOK_SECRET",
      ]);
    } catch (error) {
      return res.status(503).json({ error: error.message });
    }

    if (!Buffer.isBuffer(req.body)) {
      return res.status(400).json({ error: "Expected a raw JSON webhook body." });
    }

    const signature = req.get("X-Razorpay-Signature");
    const expectedSignature = createWebhookSignature(
      req.body,
      razorpayConfig.RAZORPAY_WEBHOOK_SECRET
    );
    if (!verifySignature(expectedSignature, signature)) {
      return res.status(400).json({ error: "Invalid Razorpay webhook signature." });
    }

    let event;
    try {
      event = JSON.parse(req.body.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "Invalid JSON webhook body." });
    }

    if (event.event !== "payment.captured") {
      return res.status(200).json({ received: true, ignored: true });
    }

    const parsedPayment = capturedPaymentSchema.safeParse(
      event.payload?.payment?.entity
    );
    if (!parsedPayment.success) {
      return res.status(400).json({
        error: "Invalid captured payment event payload.",
      });
    }

    const payment = parsedPayment.data;
    const paymentOrder = await PaymentOrder.findOne({
      razorpayOrderId: payment.order_id,
    });
    if (!paymentOrder) {
      return res.status(404).json({ error: "Payment order not found." });
    }

    try {
      const result = await creditTopUp({
        razorpayOrderId: paymentOrder.razorpayOrderId,
        paymentId: payment.id,
        amount: payment.amount,
        currency: payment.currency,
        paidVia: "WEBHOOK",
        paymentMethod: payment.method,
      });

      return res.status(200).json({
        received: true,
        credited: !result.replayed,
        orderId: result.order.razorpayOrderId,
      });
    } catch (error) {
      if (error instanceof WalletServiceError) {
        return res.status(error.statusCode).json({
          error: error.message,
          code: error.code,
        });
      }

      throw error;
    }
  }
);

module.exports = router;
