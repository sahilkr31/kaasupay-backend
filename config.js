const MONGO_URL = process.env.MONGO_URL;
const JWT_SECRET = process.env.JWT_SECRET;
const STAFF_KEY = process.env.STAFF_KEY;
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
const BANK_URL = process.env.BANK_URL || "http://localhost:4000";

if (!MONGO_URL || !JWT_SECRET) {
  console.error(
    "MONGO_URL and JWT_SECRET must be set in your .env file"
  );
  process.exit(1);
}

function getRazorpayConfiguration(required = [
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
]) {
  const config = {
    RAZORPAY_KEY_ID,
    RAZORPAY_KEY_SECRET,
    RAZORPAY_WEBHOOK_SECRET,
  };
  const missing = required.filter((name) => !config[name]);

  if (missing.length) {
    const error = new Error(
      `Razorpay is not configured. Set ${missing.join(", ")} in your .env file.`
    );
    error.code = "RAZORPAY_CONFIG_MISSING";
    throw error;
  }

  if (RAZORPAY_KEY_ID && !RAZORPAY_KEY_ID.startsWith("rzp_test_")) {
    const error = new Error(
      "Razorpay test mode is required. RAZORPAY_KEY_ID must start with rzp_test_."
    );
    error.code = "RAZORPAY_TEST_KEY_REQUIRED";
    throw error;
  }

  return config;
}

function getLocalBankUrl() {
  let url;
  try {
    url = new URL(BANK_URL);
  } catch {
    throw new Error("BANK_URL must point to the local fake bank.");
  }

  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "::1"].includes(url.hostname)
  ) {
    throw new Error("Only the local fake bank is supported; BANK_URL must use localhost.");
  }

  return url.toString().replace(/\/$/, "");
}

module.exports = {
  MONGO_URL,
  JWT_SECRET,
  STAFF_KEY,
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET,
  BANK_URL,
  getRazorpayConfiguration,
  getLocalBankUrl,
};