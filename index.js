
const express = require("express");
const apiRoutes = require("./routes");
const app = express();
const PORT = 3000;

// Parse incoming JSON request bodies
app.use(express.json());
app.use("/api/v1", apiRoutes);

// Home route: check whether the backend is running
app.get("/", (req, res) => {
  res.json({
    status: "KaasuPay backend is running"
  });
});

// Start the server
app.listen(PORT, () => {
  console.log(`KaasuPay backend is running on port ${PORT}`);
});
