
const pino = require("pino");

const logger = pino({
  level: "info",
  base: {
    service: "kaasupay-backend"
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "password",
      "token",
      "otp",
      "req.headers.authorization",
      "req.headers.cookie",
      "*.password",
      "*.token",
      "*.otp"
    ],
    censor: "[REDACTED]"
  }
});

module.exports = logger;
