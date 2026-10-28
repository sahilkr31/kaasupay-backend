const MONGO_URL = process.env.MONGO_URL;
const JWT_SECRET = process.env.JWT_SECRET;

if (!MONGO_URL || !JWT_SECRET) {
  console.error(
    "MONGO_URL and JWT_SECRET must be set in your .env file"
  );
  process.exit(1);
}

module.exports = {
  MONGO_URL,
  JWT_SECRET,
};