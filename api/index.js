
const logger = require("../logger");
const { randomUUID } = require("crypto");

function requiresDatabase(req) {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  return pathname === "/api/v1" || pathname.startsWith("/api/v1/");
}

module.exports = async function handler(req, res) {
  req.id = req.id || randomUUID();
  res.setHeader("X-Request-ID", req.id);
  try {
    const app = require("../index");

    if (requiresDatabase(req)) {
      const { connectDB } = require("../db");
      await connectDB();
    }

    return app(req, res);
  } catch (error) {
    logger.error(
      { err: error, requestId: req.id },
      "Vercel request initialization failed"
    );
    if (!res.headersSent) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({
        error: "Service temporarily unavailable",
      }));
    }
    return undefined;
  }
};

module.exports.config = {
  api: {
    bodyParser: false,
  },
};