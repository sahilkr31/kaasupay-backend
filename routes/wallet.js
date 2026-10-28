
const express = require("express");
const { Wallet } = require("../db");
const { authMiddleware } = require("../middleware");

const router = express.Router();

// GET /api/v1/wallet/balance
router.get("/balance", authMiddleware, async (req, res) => {
  const wallet = await Wallet.findOne({ userId: req.userId });

  if (!wallet) {
    return res.status(404).json({
      error: "Wallet not found",
    });
  }

  const rupees = (wallet.balance / 100).toFixed(2);

  return res.status(200).json({
    balance: wallet.balance,
    display: `₹${rupees}`,
  });
});

module.exports = router;
