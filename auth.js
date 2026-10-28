
const { timingSafeEqual } = require("crypto");
const jwt = require("jsonwebtoken");
const { JWT_SECRET, STAFF_KEY } = require("./config");

function authMiddleware(req, res, next) {
  const authorization = req.headers.authorization;

  if (!authorization || !authorization.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Please sign in first",
    });
  }

  const token = authorization.slice(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    if (!decoded.userId) {
      return res.status(401).json({
        error: "Your session is invalid or has expired. Please sign in again.",
      });
    }

    req.userId = decoded.userId;
    next();
  } catch (error) {
    return res.status(401).json({
      error: "Your session is invalid or has expired. Please sign in again.",
    });
  }
}

function staffKeyMiddleware(req, res, next) {
  if (!STAFF_KEY) {
    return res.status(503).json({
      error: "Staff operations are not configured.",
    });
  }

  const suppliedKey = req.get("x-staff-key");
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
