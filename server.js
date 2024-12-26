const express = require("express");
const bodyParser = require("body-parser");
const morgan = require("morgan");
const {
  handleMpesaExpressCallback,
  handleMpesaC2BCallback,
  handleJengaCallback,
  processPayment,
} = require("./utils");

const app = express();
const port = process.env.PORT || 3005;
app.use(morgan("dev"));

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Payment initiation route
app.post("/order/create", async (req, res) => {
  try {
    console.log("===================");
    console.log("Order created");
    console.log("===================");

    const result = await processPayment(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Callback routes for different payment methods
app.post("/order/express/callback", async (req, res) => {
  try {
    const result = await handleMpesaExpressCallback(req, res);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/order/c2b/callback", async (req, res) => {
  try {
    const result = await handleMpesaC2BCallback(req, res);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/order/jenga/callback", async (req, res) => {
  try {
    const result = await handleJengaCallback(req, res);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
