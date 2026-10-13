
const express = require("express");
const userRoutes = require("./user");
const withdrawalRoutes = require("./withdrawal");

const router = express.Router();

router.use("/user", userRoutes);
router.use("/wallet", withdrawalRoutes);

module.exports = router;
