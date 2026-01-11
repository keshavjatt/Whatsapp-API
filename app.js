const { Client, MessageMedia, LocalAuth } = require("whatsapp-web.js");
const express = require("express");
const { body, validationResult } = require("express-validator");
const socketIO = require("socket.io");
const qrcode = require("qrcode");
const http = require("http");
const fs = require("fs");
const { phoneNumberFormatter } = require("./helpers/formatter");
const fileUpload = require("express-fileupload");
const axios = require("axios");

const port = process.env.PORT || 8000;

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload({ debug: false }));

app.get("/", (req, res) => {
  res.sendFile("index.html", { root: __dirname });
});

// Global variables to track state
let clientReady = false;
let clientAuthenticated = false;
let qrCode = null;
let clientInfo = null;

// WhatsApp Client Configuration - UPDATED VERSION
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
  }
});

// WhatsApp Events - FIXED
client.on('loading_screen', (percent, message) => {
  console.log(`Loading: ${percent}% - ${message}`);
  io.emit('message', `Loading WhatsApp... ${percent}%`);
});

client.on('qr', (qr) => {
  console.log('QR Code generated');
  qrCode = qr;
  qrcode.toDataURL(qr, (err, url) => {
    if (!err) {
      io.emit('qr', url);
      io.emit('message', '📱 Scan QR Code with WhatsApp');
    }
  });
});

client.on('authenticated', (session) => {
  console.log('✅ WhatsApp AUTHENTICATED');
  clientAuthenticated = true;
  io.emit('authenticated', 'WhatsApp authenticated successfully!');
  io.emit('message', '✅ WhatsApp authenticated!');
});

client.on('ready', () => {
  console.log('✅ WhatsApp CLIENT IS READY!');
  clientReady = true;
  clientInfo = client.info;
  
  // Display client info
  console.log('Client Info:', {
    pushname: client.info?.pushname,
    wid: client.info?.wid,
    platform: client.info?.platform,
    phone: client.info?.me?.user
  });
  
  io.emit('ready', 'WhatsApp is ready!');
  io.emit('message', '✅ WhatsApp is ready to send messages!');
});

client.on('auth_failure', (msg) => {
  console.error('❌ Auth failure:', msg);
  clientReady = false;
  clientAuthenticated = false;
  io.emit('message', '❌ Authentication failed. Please try again.');
});

client.on('disconnected', (reason) => {
  console.log('❌ Client disconnected:', reason);
  clientReady = false;
  clientAuthenticated = false;
  io.emit('message', '❌ WhatsApp disconnected!');
  
  // Reinitialize after 5 seconds
  setTimeout(() => {
    console.log('Reinitializing WhatsApp...');
    client.initialize();
  }, 5000);
});

// Initialize with error handling
const initializeWhatsApp = async () => {
  try {
    console.log('Initializing WhatsApp...');
    await client.initialize();
  } catch (error) {
    console.error('Failed to initialize WhatsApp:', error);
    setTimeout(initializeWhatsApp, 10000); // Retry after 10 seconds
  }
};

initializeWhatsApp();

// Socket Connection
io.on('connection', (socket) => {
  console.log('New client connected');
  socket.emit('message', '🔗 Connected to server');
  
  // Send current status
  if (qrCode) {
    qrcode.toDataURL(qrCode, (err, url) => {
      if (!err) socket.emit('qr', url);
    });
  }
  
  if (clientReady) {
    socket.emit('ready', 'WhatsApp is ready!');
    socket.emit('message', '✅ WhatsApp is ready!');
  } else if (clientAuthenticated) {
    socket.emit('message', '✅ WhatsApp authenticated, loading...');
  }
});

// **FIXED: Check if number is registered**
const checkRegisteredNumber = async (number) => {
  try {
    console.log(`Checking if ${number} is registered...`);
    
    // Remove @c.us suffix for checking
    const checkNumber = number.replace('@c.us', '');
    const isRegistered = await client.isRegisteredUser(checkNumber + '@c.us');
    
    console.log(`Number ${number} registered: ${isRegistered}`);
    return isRegistered;
  } catch (error) {
    console.error('Error checking number:', error);
    // If can't check, assume it's registered
    return true;
  }
};

// **FIXED: Format Phone Number**
const formatPhoneNumber = (number) => {
  // Remove all non-digits
  let cleanNumber = number.toString().replace(/\D/g, '');
  
  // If starts with 0, remove it
  if (cleanNumber.startsWith('0')) {
    cleanNumber = cleanNumber.substring(1);
  }
  
  // Add country code if not present (India = 91)
  if (cleanNumber.length === 10) {
    cleanNumber = '91' + cleanNumber;
  }
  
  // Add @c.us suffix
  if (!cleanNumber.endsWith('@c.us')) {
    cleanNumber = cleanNumber + '@c.us';
  }
  
  console.log(`Formatted ${number} -> ${cleanNumber}`);
  return cleanNumber;
};

// **FIXED: Check Client State**
const isClientAvailable = () => {
  // Multiple checks for client readiness
  const isReady = clientReady || 
                  (client.pupPage && !client.pupPage.isClosed()) ||
                  client.state === 'CONNECTED';
  
  return isReady;
};

// **Status Endpoint - FIXED**
app.get("/status", (req, res) => {
  const status = {
    isReady: clientReady,
    isAuthenticated: clientAuthenticated,
    isAvailable: isClientAvailable(),
    hasQR: !!qrCode,
    user: clientInfo?.pushname || null,
    phone: clientInfo?.wid?.user || null,
    platform: process.platform,
    clientState: client.state,
    timestamp: new Date().toISOString()
  };
  
  console.log('Status check:', status);
  
  res.json({
    status: true,
    data: status
  });
});

// **FIXED: Send Message Endpoint**
app.post(
  "/send-message",
  [
    body("number").notEmpty().withMessage("Number is required"),
    body("message").notEmpty().withMessage("Message is required")
  ],
  async (req, res) => {
    try {
      console.log('\n=== Send Message Request ===');
      console.log('Request body:', req.body);
      
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          status: false,
          message: errors.array()[0].msg
        });
      }

      const rawNumber = req.body.number;
      const message = req.body.message;
      
      // Format the number
      const formattedNumber = formatPhoneNumber(rawNumber);
      console.log(`Formatted number: ${formattedNumber}`);
      
      // Check client availability with multiple conditions
      if (!isClientAvailable()) {
        console.log('Client not available. Current state:', {
          clientReady,
          clientState: client.state,
          hasPupPage: !!client.pupPage
        });
        
        return res.status(400).json({
          status: false,
          message: 'WhatsApp is not connected yet.',
          instructions: [
            '1. Go to http://localhost:8000',
            '2. Scan the QR code with WhatsApp',
            '3. Wait for "WhatsApp is ready" message',
            '4. Try again'
          ],
          currentStatus: {
            hasQR: !!qrCode,
            isAuthenticated: clientAuthenticated,
            isReady: clientReady
          }
        });
      }
      
      // Try to send message without checking registration first
      console.log(`Attempting to send message to ${formattedNumber}`);
      
      try {
        const response = await client.sendMessage(formattedNumber, message);
        
        console.log('✅ Message sent successfully!');
        console.log('Message ID:', response.id._serialized);
        console.log('Timestamp:', response.timestamp);
        
        return res.status(200).json({
          status: true,
          message: 'Message sent successfully!',
          data: {
            messageId: response.id._serialized,
            timestamp: response.timestamp,
            to: formattedNumber,
            from: clientInfo?.wid?.user || 'Unknown'
          }
        });
        
      } catch (sendError) {
        console.error('❌ Error sending message:', sendError.message);
        
        // If error is about unregistered number
        if (sendError.message.includes('not registered') || 
            sendError.message.includes('invalid number')) {
          
          return res.status(400).json({
            status: false,
            message: `The number ${rawNumber} is not registered on WhatsApp`,
            suggestion: 'Please check the phone number and try again'
          });
        }
        
        // Other errors
        return res.status(500).json({
          status: false,
          message: 'Failed to send message',
          error: sendError.message,
          details: 'Please check if WhatsApp is properly connected'
        });
      }
      
    } catch (error) {
      console.error('❌ Unexpected error in send-message:', error);
      return res.status(500).json({
        status: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  }
);

// **Test Endpoint - Simple test**
app.post("/test-send", async (req, res) => {
  try {
    // Test with a known number (can be your own)
    const testNumber = "918287698319@c.us"; // Your number
    const testMessage = "Test message from API - " + new Date().toLocaleString();
    
    console.log(`Test sending to ${testNumber}`);
    
    if (!isClientAvailable()) {
      return res.json({
        status: false,
        message: 'Client not ready',
        clientReady,
        clientState: client.state
      });
    }
    
    const response = await client.sendMessage(testNumber, testMessage);
    
    res.json({
      status: true,
      message: 'Test message sent!',
      messageId: response.id._serialized
    });
    
  } catch (error) {
    res.json({
      status: false,
      message: error.message,
      error: error.toString()
    });
  }
});

// **Debug Endpoint - Get all chats**
app.get("/debug/chats", async (req, res) => {
  try {
    if (!isClientAvailable()) {
      return res.json({ error: 'Client not ready' });
    }
    
    const chats = await client.getChats();
    const chatList = chats.map(chat => ({
      id: chat.id._serialized,
      name: chat.name,
      isGroup: chat.isGroup,
      unreadCount: chat.unreadCount
    }));
    
    res.json({
      totalChats: chats.length,
      chats: chatList.slice(0, 10) // First 10 chats only
    });
    
  } catch (error) {
    res.json({ error: error.message });
  }
});

// **Restart WhatsApp**
app.post("/restart", async (req, res) => {
  try {
    console.log('Restarting WhatsApp client...');
    
    clientReady = false;
    clientAuthenticated = false;
    qrCode = null;
    
    await client.destroy();
    setTimeout(async () => {
      await client.initialize();
    }, 2000);
    
    res.json({
      status: true,
      message: 'WhatsApp client restarting...'
    });
    
  } catch (error) {
    res.status(500).json({
      status: false,
      message: error.message
    });
  }
});

server.listen(port, () => {
  console.log(`
  ========================================
  🚀 WhatsApp API Server Started!
  ========================================
  Local: http://localhost:${port}
  Status: http://localhost:${port}/status
  ========================================
  `);
  
  // Initial status
  console.log('Initializing WhatsApp Web...');
  console.log('Please wait for QR code...');
});