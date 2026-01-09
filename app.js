const { Client, MessageMedia, LocalAuth } = require("whatsapp-web.js");
const express = require("express");
const { body, validationResult } = require("express-validator");
const socketIO = require("socket.io");
const qrcode = require("qrcode");
const http = require("http");
const axios = require("axios");
const path = require("path");

const port = process.env.PORT || 8000;

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// **FIX: Static files serve karna**
app.use(express.static(__dirname));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// **FIX: Root route ke liye index.html serve karo**
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// RATE LIMIT CONFIGURATION
const RATE_LIMIT = {
  maxMessagesPerMinute: 10,
  delayBetweenMessages: 3000,
  maxConcurrentMessages: 1,
  cooldownTime: 30000
};

// Rate limit tracking
let lastMessageTime = 0;
let messageCountInMinute = 0;
let minuteTimer = null;

// Reset message count every minute
if (!minuteTimer) {
  minuteTimer = setInterval(() => {
    messageCountInMinute = 0;
    console.log('🔄 Rate limit counter reset');
  }, 60000);
}

const client = new Client({
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
  },
  authStrategy: new LocalAuth({
    dataPath: './.wwebjs_auth'
  }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  },
  takeoverOnConflict: false,
  restartOnAuthFail: false
});

// WhatsApp Events
client.on('qr', (qr) => {
  console.log('🔐 QR Code generated');
  qrcode.toDataURL(qr, (err, url) => {
    if (!err) {
      io.emit('qr', url);
      io.emit('message', 'Scan QR Code');
    }
  });
});

client.on('ready', () => {
  console.log('✅ WhatsApp READY!');
  console.log('User:', client.info?.pushname);
  console.log('Phone:', client.info?.wid?.user);
  
  io.emit('ready', 'WhatsApp is ready!');
  io.emit('message', '✅ WhatsApp is ready!');
});

client.on('authenticated', () => {
  console.log('✅ WhatsApp AUTHENTICATED');
  io.emit('authenticated', 'Authenticated');
});

client.on('disconnected', async (reason) => {
  console.log(`⚠️  Disconnected: ${reason}`);
  
  if (reason.includes('rate') || reason.includes('block') || reason.includes('limit')) {
    console.log('🛑 RATE LIMIT DETECTED! Waiting 30 seconds...');
    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT.cooldownTime));
    console.log('🔄 Reinitializing after cooldown...');
  }
  
  try {
    await client.destroy();
    await new Promise(resolve => setTimeout(resolve, 2000));
    await client.initialize();
  } catch (error) {
    console.log('Restart error:', error.message);
  }
});

client.initialize();

// Socket IO Connection
io.on('connection', (socket) => {
  console.log('New client connected');
  socket.emit('message', 'Connected to server');
  
  if (client.info) {
    socket.emit('ready', 'WhatsApp is ready!');
  }
  
  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Format Phone Number
const formatPhoneNumber = (number) => {
  let cleanNumber = number.toString().replace(/\D/g, '');
  
  if (cleanNumber.startsWith('0')) {
    cleanNumber = cleanNumber.substring(1);
  }
  
  if (cleanNumber.length === 10) {
    cleanNumber = '91' + cleanNumber;
  }
  
  if (!cleanNumber.endsWith('@c.us')) {
    cleanNumber = cleanNumber + '@c.us';
  }
  
  return cleanNumber;
};

// Rate Limit Protected Send Function
const sendMessageWithProtection = async (number, message) => {
  const formattedNumber = formatPhoneNumber(number);
  console.log(`📤 Preparing to send to: ${formattedNumber.substring(0, 10)}...`);
  
  // 1. Check rate limit per minute
  if (messageCountInMinute >= RATE_LIMIT.maxMessagesPerMinute) {
    console.log(`⏳ Rate limit reached (${messageCountInMinute}/${RATE_LIMIT.maxMessagesPerMinute}). Waiting...`);
    const waitTime = 61000;
    await new Promise(resolve => setTimeout(resolve, waitTime));
    messageCountInMinute = 0;
  }
  
  // 2. Check delay between messages
  const now = Date.now();
  const timeSinceLastMessage = now - lastMessageTime;
  
  if (timeSinceLastMessage < RATE_LIMIT.delayBetweenMessages) {
    const waitTime = RATE_LIMIT.delayBetweenMessages - timeSinceLastMessage;
    console.log(`⏳ Too soon since last message. Waiting ${waitTime}ms...`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  
  // 3. Send the message
  console.log(`✅ Sending to ${formattedNumber.substring(0, 10)}...`);
  
  try {
    const result = await client.sendMessage(formattedNumber, message);
    
    lastMessageTime = Date.now();
    messageCountInMinute++;
    
    console.log(`✅ Sent! (${messageCountInMinute}/${RATE_LIMIT.maxMessagesPerMinute} this minute)`);
    return result;
    
  } catch (error) {
    console.error(`❌ Send failed: ${error.message}`);
    
    if (error.message.includes('rate limit') || 
        error.message.includes('too many') || 
        error.message.includes('blocked')) {
      
      console.log('🛑 RATE LIMIT ERROR DETECTED!');
      messageCountInMinute = RATE_LIMIT.maxMessagesPerMinute;
      
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT.cooldownTime));
      messageCountInMinute = 0;
      
      console.log('🔄 Retrying after cooldown...');
      return sendMessageWithProtection(number, message);
    }
    
    throw error;
  }
};

// SEND-MESSAGE ENDPOINT
app.post(
  "/send-message",
  [
    body("number").notEmpty().withMessage("Number is required"),
    body("message").notEmpty().withMessage("Message is required")
  ],
  async (req, res) => {
    try {
      console.log('=== Send Message Request ===');
      
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          status: false,
          message: errors.array()[0].msg
        });
      }

      const { number, message } = req.body;
      
      if (!client.pupPage || client.pupPage.isClosed()) {
        return res.status(400).json({
          status: false,
          message: 'WhatsApp not connected. Please scan QR code first.'
        });
      }
      
      const result = await sendMessageWithProtection(number, message);
      
      return res.status(200).json({
        status: true,
        message: 'Message sent successfully',
        data: {
          messageId: result.id._serialized,
          timestamp: result.timestamp,
          to: number,
          rateLimitInfo: {
            messagesThisMinute: messageCountInMinute,
            maxPerMinute: RATE_LIMIT.maxMessagesPerMinute
          }
        }
      });
      
    } catch (error) {
      console.error('❌ Send message error:', error);
      
      return res.status(500).json({
        status: false,
        message: error.message || 'Failed to send message',
        errorType: error.message.includes('rate limit') ? 'RATE_LIMIT' : 'OTHER'
      });
    }
  }
);

// STATUS ENDPOINT
app.get("/status", (req, res) => {
  const status = {
    isReady: !!client.info,
    isAuthenticated: client.pupPage ? true : false,
    user: client.info?.pushname || null,
    phone: client.info?.wid?.user || null,
    platform: process.platform,
    rateLimit: {
      messagesThisMinute: messageCountInMinute,
      maxPerMinute: RATE_LIMIT.maxMessagesPerMinute
    },
    timestamp: new Date().toISOString()
  };
  
  res.json({
    status: true,
    data: status
  });
});

// RESET RATE LIMIT
app.post("/reset-rate-limit", (req, res) => {
  messageCountInMinute = 0;
  lastMessageTime = 0;
  console.log('🔄 Rate limit manually reset');
  
  res.json({
    status: true,
    message: 'Rate limit counters reset'
  });
});

server.listen(port, () => {
  console.log(`
  ========================================
  🚀 WhatsApp API
  ========================================
  Local: http://localhost:${port}
  Status: http://localhost:${port}/status
  ========================================
  Rate Limit: ${RATE_LIMIT.maxMessagesPerMinute} messages/minute
  Delay: ${RATE_LIMIT.delayBetweenMessages}ms between messages
  ========================================
  `);
});