require("dotenv").config();
const express = require("express");
const path = require("path");
const { randomUUID } = require("crypto");
const apiRoutes = require("./routes");
const razorpayWebhookRoutes = require("./routes/razorpayWebhook");
const logger = require("./logger");
const { connectDB } = require("./db");

const app = express();
const PORT = 3000;

// Generate a unique ID for every incoming request
app.use((req, res, next) => {
  req.id = randomUUID();
  res.setHeader("X-Request-ID", req.id);
  next();
});
// Keep a bounded sample of recent request durations
const MAX_DURATION_SAMPLES = 1000;
const durationSamples = [];
// Calculate average and p99 latency from recent requests
function getLatencyStats() {
  if (durationSamples.length === 0) {
    return {
      sampleCount: 0,
      averageMs: 0,
      p99Ms: 0
    };
  }

  const sorted = [...durationSamples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, duration) => sum + duration, 0);

  const p99Index = Math.ceil(sorted.length * 0.99) - 1;

  return {
    sampleCount: sorted.length,
    averageMs: Number((total / sorted.length).toFixed(2)),
    p99Ms: Number(sorted[p99Index].toFixed(2))
  };
}

// Measure how long each request takes
app.use((req, res, next) => {
  const startTime = process.hrtime.bigint();

  res.on("finish", () => {
    const endTime = process.hrtime.bigint();
    const durationMs = Number(endTime - startTime) / 1_000_000;
    // Store this duration for latency statistics
durationSamples.push(durationMs);

if (durationSamples.length > MAX_DURATION_SAMPLES) {
  durationSamples.shift();
}

    logger.info(
      {
        requestId: req.id,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Number(durationMs.toFixed(2))
      },
      "Request completed"
    );
  });

  next();
});

// Verify the Razorpay signature over the untouched request bytes.
app.use("/api/v1/webhooks", razorpayWebhookRoutes);

// Serve the simple Razorpay Checkout test page.
app.use(express.static(path.join(__dirname, "public")));

// Parse JSON for the remaining API routes.
app.use(express.json());

// Mount API routes
app.use("/api/v1", apiRoutes);
// Handle errors from API routes
app.use((err, req, res, next) => {
  logger.error(
    {
      err,
      requestId: req.id,
    },
    "Request failed"
  );

  if (res.headersSent) {
    return next(err);
  }

  return res.status(500).json({
    error: "Internal server error",
  });
});

// Home route: check whether the backend is running
app.get("/", (req, res) => {
  res.json({
    status: "KaasuPay backend is running"
  });
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok"
  });
});
// Latency statistics for recent requests
app.get("/monitoring/latency", (req, res) => {
  res.status(200).json(getLatencyStats());
});

// Connect to MongoDB before starting the server
async function startServer() {
  try {
    await connectDB();

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to connect to MongoDB");
    process.exit(1);
  }
}

startServer();