// Payment Gateway Integration for Shopify

const axios = require("axios");
require("dotenv").config();
const { paymentProviders } = require("./paymentProviders");

// Shopify Configuration
const shopifyStore = process.env.SHOPIFY_STORE;
const shopifyApiKey = process.env.SHOPIFY_API_KEY;
const shopifyPassword = process.env.SHOPIFY_PASSWORD;
const shopifyAccessToken = process.env.SHOPIFY_ACCESS_TOKEN;

// Handle M-pesa callback
async function handleMpesaExpressCallback(req, res) {
  const callbackData = req.body;

  console.log("express callbackData", callbackData);

  if (callbackData.Body.stkCallback.ResultCode === 0) {
    // Payment successful
    const amount = callbackData.Body.stkCallback.CallbackMetadata.Item.find(
      (item) => item.Name === "Amount"
    ).Value;
    const mpesaReceiptNumber =
      callbackData.Body.stkCallback.CallbackMetadata.Item.find(
        (item) => item.Name === "MpesaReceiptNumber"
      ).Value;
    const phoneNumber =
      callbackData.Body.stkCallback.CallbackMetadata.Item.find(
        (item) => item.Name === "PhoneNumber"
      ).Value;

    try {
      // Update order status in Shopify
      await updateShopifyOrder(callbackData.Body.stkCallback.AccountReference, {
        status: "paid",
        mpesaReceiptNumber,
        amount,
        phoneNumber,
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error updating Shopify order:", error);
      res.json({
        success: false,
        error: "Failed to update order status",
      });
    }
  } else {
    // Payment failed
    console.error("Payment failed:", callbackData.Body.stkCallback.ResultDesc);
    res.json({
      success: false,
      error: callbackData.Body.stkCallback.ResultDesc,
    });
  }
}

// Update Shopify order
async function updateShopifyOrder(orderId, paymentDetails) {
  // Implement Shopify order update logic here using Shopify Admin API
  try {
    // Update order tags, status, and add payment details as metadata
    const url = `https://${shopifyApiKey}:${shopifyPassword}@${shopifyStore}/admin/api/2024-10/orders/${orderId}.json`;
    const shopifyResponse = await axios.put(
      url,
      {
        order: {
          tags: `paid, mpesa_receipt_${paymentDetails.mpesaReceiptNumber}`,
          financial_status: "paid",
          note: `M-pesa Payment Received\nReceipt: ${paymentDetails.mpesaReceiptNumber}\nAmount: ${paymentDetails.amount}\nPhone: ${paymentDetails.phoneNumber}`,
        },
      },
      {
        headers: {
          "X-Shopify-Access-Token": shopifyAccessToken,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("Shopify order updated successfully");
    return shopifyResponse.data;
  } catch (error) {
    console.error("Error updating Shopify order:", error);
    throw error;
  }
}

// Example usage in Shopify checkout
async function processPayment(orderDetails) {
  try {
    const paymentMethod = orderDetails.payment_gateway_names[0];
    let provider;

    switch (paymentMethod.toLowerCase()) {
      case "m-pesa express":
        provider = paymentProviders["mpesa-express"];
        break;
      case "m-pesa c2b":
        provider = paymentProviders["mpesa-c2b"];
        break;
      case "jenga":
        provider = paymentProviders["jenga"];
        break;
      default:
        throw new Error(`Unsupported payment method: ${paymentMethod}`);
    }

    console.log("payment method----", paymentMethod);

    // Format phone number if needed
    let phoneNumber = orderDetails.billing_address.phone;
    if (phoneNumber) {
      phoneNumber = formatPhoneNumber(phoneNumber);
    }

    const amount = parseFloat(orderDetails.total_price);
    const orderId = orderDetails.id;
    console.log("order details", orderId);
    const paymentResponse = await provider.initializePayment({
      phoneNumber,
      amount,
      orderId,
      currency: orderDetails.currency,
      customerDetails: {
        name: orderDetails.billing_address.name,
        email: orderDetails.email,
        phone: phoneNumber,
      },
    });

    console.log("payment response----", paymentResponse);

    return {
      success: true,
      provider: provider.name,
      ...paymentResponse,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
}

// Helper function to format phone numbers
function formatPhoneNumber(phoneNumber) {
  phoneNumber = phoneNumber.replace(/\D/g, "");
  if (phoneNumber.startsWith("0")) {
    phoneNumber = "254" + phoneNumber.substring(1);
  } else if (!phoneNumber.startsWith("254")) {
    phoneNumber = "254" + phoneNumber;
  }
  return phoneNumber;
}

const handleMpesaC2BCallback = async (req, res) => {
  const callbackData = req.body;

  console.log("c2b callbackData", callbackData);
  const { path } = req.route;
  const provider = paymentProviders["mpesa-c2b"];

  try {
    // Handle validation request
    if (path.endsWith("/validation")) {
      const validationResponse = await provider.validatePayment(req.body);
      return res.json(validationResponse);
    }

    // Handle confirmation request
    if (path.endsWith("/confirmation")) {
      const confirmationResponse = await provider.confirmPayment(req.body);
      return res.json(confirmationResponse);
    }

    // If neither validation nor confirmation, return error
    return res.status(400).json({
      ResultCode: 1,
      ResultDesc: "Invalid callback type",
    });
  } catch (error) {
    console.error("C2B callback error:", error);
    return res.status(500).json({
      ResultCode: 1,
      ResultDesc: "Internal server error",
    });
  }
};

const handleJengaCallback = async (req, res) => {
  try {
    const callbackData = req.body;

    console.log("jenga callbackData", callbackData);
    const {
      transactionId,
      orderReference: orderId,
      status,
      amount,
      currency,
      paymentDetails,
    } = req.body;

    // Verify the callback authenticity using Jenga's signature
    const signature = req.headers["x-jenga-signature"];
    if (!verifyJengaSignature(req.body, signature)) {
      return res.status(400).json({
        success: false,
        error: "Invalid signature",
      });
    }

    if (status === "SUCCESS") {
      // Update order status in Shopify
      await updateShopifyOrder(orderId, {
        status: "paid",
        transactionId: transactionId,
        amount: amount,
        currency: currency,
        paymentMethod: "Jenga",
        paymentDetails: paymentDetails,
      });

      return res.json({
        success: true,
        message: "Payment processed successfully",
      });
    } else {
      // Handle failed payment
      console.error("Jenga payment failed:", req.body);
      return res.json({
        success: false,
        error: `Payment failed: ${status}`,
      });
    }
  } catch (error) {
    console.error("Jenga callback error:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
};

// Helper function to verify Jenga's signature
function verifyJengaSignature(payload, signature) {
  try {
    const crypto = require("crypto");
    const data = JSON.stringify(payload);
    const expectedSignature = crypto
      .createHmac("sha256", process.env.JENGA_CONSUMER_SECRET)
      .update(data)
      .digest("hex");

    return signature === expectedSignature;
  } catch (error) {
    console.error("Signature verification failed:", error);
    return false;
  }
}

module.exports = {
  processPayment,
  handleMpesaExpressCallback,
  handleMpesaC2BCallback,
  handleJengaCallback,
};
