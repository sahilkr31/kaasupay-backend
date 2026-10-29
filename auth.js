
const { timingSafeEqual } = require("crypto");
const jwt = require("jsonwebtoken");
const { User } = require("./db");
const { JWT_SECRET, STAFF_KEY } = require("./config");

async function authMiddleware(req, res, next) {
  const authorization = req.headers.authorization;

  if (!authorization || !authorization.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Please sign in first",
    });
  }

  const token = authorization.slice(7);

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return res.status(401).json({
      error: "Your session is invalid or has expired. Please sign in again.",
    });
  }

  if (!decoded.userId) {
    return res.status(401).json({
      error: "Your session is invalid or has expired. Please sign in again.",
    });
  }

  const user = await User.findById(decoded.userId)
    .select("tokenVersion")
    .lean();
  if (!user || decoded.tv !== (user.tokenVersion || 0)) {
    return res.status(401).json({
      message: "Session ended. Please sign in again",
    });
  }

  req.userId = decoded.userId;
  return next();
}

function staffKeyMiddleware(req, res, next) {
  if (!STAFF_KEY) {
    return res.status(503).json({
      error: "Staff operations are not configured.",
    });
  }

  const suppliedKey = req.get("x-staff-key") || req.get("x-admin-key");
  if (!suppliedKey) {
    return res.status(401).json({
      error: "A valid staff key is required.",
    });
  }

  const suppliedBuffer = Buffer.from(suppliedKey);
  const configuredBuffer = Buffer.from(STAFF_KEY);
  if (
    suppliedBuffer.length !== configuredBuffer.length ||
    !timingSafeEqual(suppliedBuffer, configuredBuffer)
  ) {
    return res.status(403).json({
      error: "Staff authorization failed.",
    });
  }

  next();
}

module.exports = { authMiddleware, staffKeyMiddleware };
