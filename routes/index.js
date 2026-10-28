

const express = require("express");
const userRoutes = require("./user");
const withdrawalRoutes = require("./withdrawal");
const walletRoutes = require("./wallet");

const router = express.Router();

router.use("/user", userRoutes);
router.use("/wallet", withdrawalRoutes);
router.use("/wallet", walletRoutes);

module.exports = router;
