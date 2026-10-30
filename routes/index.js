

const express = require("express");
const adminRoutes = require("./admin");
const userRoutes = require("./user");
const withdrawalRoutes = require("./withdrawal");
const walletRoutes = require("./wallet");
const requestRoutes = require("./requests");

const router = express.Router();

router.use("/user", userRoutes);
router.use("/admin", adminRoutes);
router.use("/wallet", withdrawalRoutes);
router.use("/wallet", walletRoutes);
router.use("/requests", requestRoutes);

module.exports = router;
