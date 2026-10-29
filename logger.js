
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
      "pin",
      "pinHash",
      "token",
      "otp",
      "req.headers.authorization",
      "req.headers.cookie",
      "*.password",
      "*.pin",
      "*.pinHash",
      "*.token",
      "*.otp"
    ],
    censor: "[REDACTED]"
  }
});

module.exports = logger;
