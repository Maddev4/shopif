const axios = require("axios");
require("dotenv").config();
const crypto = require("crypto");

// M-pesa Express Provider
const mpesaExpressProvider = {
  name: "M-Pesa Express",
  async initializePayment(orderDetails) {
    const { phoneNumber, amount, orderId } = orderDetails;
    const accessToken = await getAccessToken();
    const timestamp = new Date()
      .toISOString()
      .replace(/[^0-9]/g, "")
      .slice(0, -3);
    const password = Buffer.from(
      process.env.BUSINESS_SHORT_CODE_EXPRESS + process.env.PASSKEY + timestamp
    ).toString("base64");

    const requestBody = {
      BusinessShortCode: process.env.BUSINESS_SHORT_CODE_EXPRESS,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: amount,
      PartyA: phoneNumber,
      PartyB: process.env.BUSINESS_SHORT_CODE_EXPRESS,
      PhoneNumber: phoneNumber,
      CallBackURL: process.env.MPESA_EXPRESS_CALLBACK_URL,
      AccountReference: orderId,
      TransactionDesc: `Payment for Order ${orderId}`,
    };

    console.log("requestBody", requestBody);

    try {
      const response = await axios.post(
        "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
        requestBody,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );
      console.log("response", response.data);
      return {
        success: true,
        checkoutRequestId: response.data.CheckoutRequestID,
        merchantRequestId: response.data.MerchantRequestID,
        responseCode: response.data.ResponseCode,
        responseDescription: response.data.ResponseDescription,
      };
    } catch (error) {
      throw new Error(`M-Pesa Express payment failed: ${error.message}`);
    }
  },
};

// M-pesa C2B Provider
const mpesaC2BProvider = {
  name: "M-Pesa C2B",
  async initializePayment(orderDetails) {
    const { phoneNumber, amount, orderId } = orderDetails;
    const accessToken = await getAccessToken();
    const timestamp = new Date()
      .toISOString()
      .replace(/[^0-9]/g, "")
      .slice(0, -3);

    try {
      // Register C2B URL if not already registered
      const c2bRegisterResponse = await axios.post(
        "https://sandbox.safaricom.co.ke/mpesa/c2b/v1/registerurl",
        {
          ShortCode: process.env.BUSINESS_SHORT_CODE_C2B,
          ResponseType: "Completed",
          ConfirmationURL: process.env.MPESA_C2B_CALLBACK_URL + "/confirmation",
          ValidationURL: process.env.MPESA_C2B_CALLBACK_URL + "/validation",
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );
      console.log("c2bRegisterResponse", c2bRegisterResponse.data);

      // Simulate C2B transaction (for testing in sandbox)
      if (process.env.NODE_ENV === "development") {
        const c2bSimulateResponse = await axios.post(
          "https://sandbox.safaricom.co.ke/mpesa/c2b/v1/simulate",
          {
            ShortCode: process.env.BUSINESS_SHORT_CODE_C2B,
            CommandID: "CustomerPayBillOnline",
            Amount: amount,
            Msisdn: phoneNumber,
            BillRefNumber: orderId,
          },
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          }
        );
        console.log("c2bSimulateResponse", c2bSimulateResponse.data);
      }

      console.log("storeOrderDetails start");

      // Store order details for validation during callback
      await storeOrderDetails(orderId, {
        amount,
        phoneNumber,
        timestamp,
        status: "pending",
      });

      return {
        success: true,
        message:
          `Please pay KES ${amount} using:\n` +
          `Paybill Number: ${process.env.BUSINESS_SHORT_CODE_C2B}\n` +
          `Account Number: ${orderId}`,
        paybillNumber: process.env.BUSINESS_SHORT_CODE_C2B,
        accountNumber: orderId,
        amount: amount,
        phoneNumber: phoneNumber,
        orderId: orderId,
        timestamp: timestamp,
      };
    } catch (error) {
      console.error("M-Pesa C2B initialization failed:", error);
      throw new Error(`M-Pesa C2B payment failed: ${error.message}`);
    }
  },

  async validatePayment(validationData) {
    // This method is called by the M-Pesa C2B validation webhook endpoint
    // to validate incoming payments before they are processed
    // Used in handleMpesaC2BCallback in utils.js
    const { BusinessShortCode, AccountReference, TransAmount } = validationData;

    try {
      // Verify the business short code matches our paybill number
      if (BusinessShortCode !== process.env.BUSINESS_SHORT_CODE_C2B) {
        return {
          ResultCode: "C2B00010",
          ResultDesc: "Invalid business short code",
        };
      }

      // Retrieve stored order details
      const orderDetails = await getOrderDetails(AccountReference);

      if (!orderDetails) {
        return {
          ResultCode: "C2B00011",
          ResultDesc: "Invalid account number",
        };
      }

      if (parseFloat(TransAmount) !== parseFloat(orderDetails.amount)) {
        return {
          ResultCode: "C2B00012",
          ResultDesc: "Invalid amount",
        };
      }

      return {
        ResultCode: 0,
        ResultDesc: "Accepted",
      };
    } catch (error) {
      console.error("Payment validation failed:", error);
      return {
        ResultCode: "C2B00013",
        ResultDesc: "Internal server error",
      };
    }
  },

  async confirmPayment(confirmationData) {
    // This method is called by the M-Pesa C2B confirmation webhook endpoint
    // after a payment is completed to update order status
    // Used in handleMpesaC2BCallback in utils.js
    const { TransID, TransAmount, BusinessShortCode, BillRefNumber, MSISDN } =
      confirmationData;

    try {
      // Verify the business short code matches our paybill number
      if (BusinessShortCode !== process.env.BUSINESS_SHORT_CODE_C2B) {
        return {
          ResultCode: 1,
          ResultDesc: "Invalid business short code",
        };
      }

      // Update order status in database
      await updateOrderPayment(BillRefNumber, {
        transactionId: TransID,
        amount: TransAmount,
        phoneNumber: MSISDN,
        status: "completed",
      });

      // Update order in Shopify
      await updateShopifyOrder(BillRefNumber, {
        status: "paid",
        mpesaReceiptNumber: TransID,
        amount: TransAmount,
        phoneNumber: MSISDN,
      });

      return {
        ResultCode: 0,
        ResultDesc: "Success",
      };
    } catch (error) {
      console.error("Payment confirmation failed:", error);
      return {
        ResultCode: 1,
        ResultDesc: "Failed to process payment",
      };
    }
  },
};

// Jenga API Provider
const jengaProvider = {
  name: "Jenga",
  async initializePayment(orderDetails) {
    const { amount, currency, orderId, customerDetails } = orderDetails;

    try {
      console.log("Jenga provider start----");

      // Get Bearer token first
      const tokenResponse = await axios.post(
        "https://uat.finserve.africa/authentication/api/v3/authenticate/merchant",
        {
          merchantCode: process.env.JENGA_MERCHANT_CODE,
          consumerSecret: process.env.JENGA_CONSUMER_SECRET,
        },
        {
          headers: {
            "Api-Key": process.env.JENGA_API_KEY,
            "Content-Type": "application/json",
          },
        }
      );

      console.log("Jenga token response:", tokenResponse.data);

      const bearerToken = tokenResponse.data.accessToken;

      // Make payment request
      const response = await axios.post(
        "https://api-uat.jengaapi.io/transaction/v3/checkout/payment",
        {
          merchantCode: process.env.JENGA_MERCHANT_CODE,
          orderReference: orderId,
          amount: {
            amount: amount,
            currencyCode: currency || "KES",
          },
          callbackUrl: process.env.JENGA_CALLBACK_URL,
          customer: {
            name: customerDetails.name,
            email: customerDetails.email,
            phone: customerDetails.phone,
          },
          paymentMethods: ["MPESA", "CARD"],
          expiryMinutes: 60,
        },
        {
          headers: {
            Authorization: `Bearer ${bearerToken}`,
            "Api-Key": process.env.JENGA_API_KEY,
            "Content-Type": "application/json",
            Signature: generateJengaSignature(orderId, amount),
          },
        }
      );

      console.log("Jenga response:", response.data);

      return {
        success: true,
        paymentUrl: response.data.checkoutUrl,
        transactionId: response.data.transactionId,
      };
    } catch (error) {
      console.error(
        "Jenga error details:",
        error.response?.data || error.message
      );
      throw new Error(`Jenga payment initialization failed: ${error.message}`);
    }
  },
};

// Helper function to get M-Pesa access token
async function getAccessToken() {
  const auth = Buffer.from(
    `${process.env.CONSUMER_KEY}:${process.env.CONSUMER_SECRET}`
  ).toString("base64");
  try {
    const response = await axios.get(
      "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      {
        headers: {
          Authorization: `Basic ${auth}`,
        },
      }
    );
    return response.data.access_token;
  } catch (error) {
    throw new Error(`Failed to get access token: ${error.message}`);
  }
}

// Helper function to generate Jenga signature
function generateJengaSignature(orderId, amount) {
  const signatureString = `${orderId}${amount}${process.env.JENGA_API_SECRET}`;
  return crypto.createHash("sha256").update(signatureString).digest("hex");
}

// Helper functions for order management
async function storeOrderDetails(orderId, details) {
  // In a production environment, this should store data in a database
  // For this example, we'll use a simple in-memory store
  if (!global.orderStore) {
    global.orderStore = new Map();
  }
  global.orderStore.set(orderId, details);
}

async function getOrderDetails(orderId) {
  // In a production environment, this should fetch from a database
  if (!global.orderStore) {
    return null;
  }
  return global.orderStore.get(orderId);
}

async function updateOrderPayment(orderId, paymentDetails) {
  // In a production environment, this should update the database
  if (!global.orderStore) {
    return null;
  }
  const orderDetails = global.orderStore.get(orderId);
  if (orderDetails) {
    global.orderStore.set(orderId, {
      ...orderDetails,
      ...paymentDetails,
    });
  }
}

// Helper function to update Shopify order
async function updateShopifyOrder(orderId, paymentDetails) {
  const shopifyApiKey = process.env.SHOPIFY_API_KEY;
  const shopifyPassword = process.env.SHOPIFY_PASSWORD;
  const shopifyStore = process.env.SHOPIFY_STORE;
  const shopifyAccessToken = process.env.SHOPIFY_ACCESS_TOKEN;

  try {
    const url = `https://${shopifyApiKey}:${shopifyPassword}@${shopifyStore}/admin/api/2024-01/orders/${orderId}.json`;
    await axios.put(
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
  } catch (error) {
    console.error("Error updating Shopify order:", error);
    throw error;
  }
}

// Payment provider registry
const paymentProviders = {
  "mpesa-express": mpesaExpressProvider,
  "mpesa-c2b": mpesaC2BProvider,
  jenga: jengaProvider,
};

module.exports = {
  paymentProviders,
};
