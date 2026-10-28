
const mongoose = require("mongoose");
const { MONGO_URL } = require("./config");

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    firstName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 50,
    },
    lastName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 50,
    },
    passwordHash: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

const walletSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    balance: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: "Balance must be an integer number of paise",
      },
    },
  },
  { timestamps: true }
);

const User = mongoose.model("User", userSchema);
const Wallet = mongoose.model("Wallet", walletSchema);

async function connectDB() {
  await mongoose.connect(MONGO_URL);
  console.log("Connected to MongoDB");
}

module.exports = {
  connectDB,
  User,
  Wallet,
};
