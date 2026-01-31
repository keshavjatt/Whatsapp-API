const { Client, MessageMedia, LocalAuth } = require("whatsapp-web.js");
const express = require("express");
const { body, validationResult } = require("express-validator");
const socketIO = require("socket.io");
const qrcode = require("qrcode");
const http = require("http");
const fs = require("fs");
const path = require("path");
const fileUpload = require("express-fileupload");

const port = process.env.PORT || 8000;

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload({ debug: false }));
app.use(express.static(__dirname));

// Create auth directory if not exists
const authDir = './.wwebjs_auth';
if (!fs.existsSync(authDir)) {
  fs.mkdirSync(authDir, { recursive: true });
  console.log('✅ Created auth directory');
}

// Global state
let clientReady = false;
let clientAuthenticated = false;
let qrCode = null;
let clientInfo = null;
let sessionRestored = false;

// **FIXED: Client Configuration**
const client = new Client({
  // **IMPORTANT: Use latest web version**
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2413.51.html',
  },
  
  // **IMPORTANT: LocalAuth with proper config**
  authStrategy: new LocalAuth({
    clientId: "whatsapp-bot",
    dataPath: authDir,
    backupSyncIntervalMs: 300000 // 5 minutes
  }),
  
  // **FIXED: Puppeteer config**
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--window-size=1024,768'
    ],
    ignoreDefaultArgs: ['--disable-extensions'],
    timeout: 60000
  },
  
  // Client options
  ffmpegPath: process.env.FFMPEG_PATH || null,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
});

// **Event Listeners - FIXED ORDER**

// 1. Loading screen
client.on('loading_screen', (percent, message) => {
  console.log(`📱 LOADING: ${percent}% - ${message}`);
  io.emit('loading', { percent, message });
});

// 2. QR Code
client.on('qr', (qr) => {
  console.log('🔐 QR Code generated - Scan with WhatsApp');
  qrCode = qr;
  qrcode.toDataURL(qr, (err, url) => {
    if (!err) {
      io.emit('qr', url);
      io.emit('message', '📱 Scan QR Code with WhatsApp');
      console.log('QR Code displayed to client');
    }
  });
});

// 3. Authenticated - FIXED
client.on('authenticated', () => {
  console.log('✅ AUTHENTICATED - Session saved locally');
  clientAuthenticated = true;
  sessionRestored = true;
  io.emit('authenticated', 'WhatsApp authenticated!');
  io.emit('message', '✅ WhatsApp authenticated! Loading messages...');
});

// 4. Auth Failure
client.on('auth_failure', (msg) => {
  console.error('❌ AUTH FAILURE:', msg);
  clientReady = false;
  clientAuthenticated = false;
  io.emit('auth_failure', msg);
  io.emit('message', `❌ Auth failed: ${msg}`);
});

// 5. READY - MOST IMPORTANT
client.on('ready', () => {
  console.log('🎉 WHATSAPP CLIENT IS READY!');
  console.log('========================================');
  
  clientReady = true;
  clientInfo = client.info;
  
  // Display client info
  if (clientInfo) {
    console.log('📋 CLIENT INFO:');
    console.log(`👤 User: ${clientInfo.pushname || 'Unknown'}`);
    console.log(`📞 Phone: ${clientInfo.me?.user || 'Unknown'}`);
    console.log(`🆔 Wid: ${clientInfo.wid?.user || 'Unknown'}`);
    console.log(`🖥️ Platform: ${clientInfo.platform || 'Unknown'}`);
    console.log('========================================');
  }
  
  // Emit to all clients
  io.emit('ready', {
    message: 'WhatsApp is ready!',
    user: clientInfo?.pushname,
    phone: clientInfo?.me?.user
  });
  
  io.emit('message', `✅ WhatsApp ready! Logged in as: ${clientInfo?.pushname || 'User'}`);
});

// 6. Disconnected
client.on('disconnected', (reason) => {
  console.log(`❌ DISCONNECTED: ${reason}`);
  clientReady = false;
  clientAuthenticated = false;
  
  io.emit('disconnected', reason);
  io.emit('message', `❌ Disconnected: ${reason}`);
  
  // Auto-reconnect after 5 seconds
  setTimeout(() => {
    console.log('🔄 Attempting to reconnect...');
    client.initialize();
  }, 5000);
});

// 7. Change State
client.on('change_state', (state) => {
  console.log(`🔄 State changed to: ${state}`);
  io.emit('state_change', state);
});

// 8. Message Received
client.on('message', async (msg) => {
  console.log(`📩 Message from ${msg.from}: ${msg.body?.substring(0, 50)}`);
});

// **Initialize Function**
const initializeWhatsApp = async () => {
  try {
    console.log('\n🚀 Initializing WhatsApp Client...');
    console.log('Auth directory:', authDir);
    
    // Check if session exists
    const sessionFiles = fs.existsSync(authDir) ? fs.readdirSync(authDir) : [];
    console.log(`Session files: ${sessionFiles.length > 0 ? sessionFiles.join(', ') : 'No session found'}`);
    
    await client.initialize();
    console.log('✅ Client initialization started');
    
  } catch (error) {
    console.error('❌ Initialization error:', error.message);
    
    // If initialization fails, clear auth and retry
    if (error.message.includes('Failed to launch') || error.message.includes('Protocol error')) {
      console.log('🔄 Clearing auth and retrying...');
      
      // Clear auth directory
      if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true });
        fs.mkdirSync(authDir, { recursive: true });
      }
      
      // Retry after 3 seconds
      setTimeout(initializeWhatsApp, 3000);
    }
  }
};

// **Socket.IO Connection**
io.on('connection', (socket) => {
  console.log(`🔗 Client connected: ${socket.id}`);
  
  socket.emit('message', 'Connected to WhatsApp API server');
  
  // Send current status
  if (qrCode) {
    qrcode.toDataURL(qrCode, (err, url) => {
      if (!err) socket.emit('qr', url);
    });
  }
  
  if (clientReady) {
    socket.emit('ready', {
      message: 'WhatsApp is ready!',
      user: clientInfo?.pushname
    });
  } else if (clientAuthenticated) {
    socket.emit('message', '✅ Authenticated, loading messages...');
  }
  
  // Handle manual commands
  socket.on('get_status', () => {
    socket.emit('status', {
      ready: clientReady,
      authenticated: clientAuthenticated,
      user: clientInfo?.pushname
    });
  });
  
  socket.on('restart', () => {
    console.log('Manual restart requested');
    client.destroy().then(() => {
      setTimeout(initializeWhatsApp, 2000);
    });
  });
});

// **Initialize WhatsApp**
setTimeout(() => {
  initializeWhatsApp();
}, 1000);

// **MIDDLEWARE: Check client ready**
const checkClientReady = (req, res, next) => {
  if (!clientReady) {
    return res.status(400).json({
      status: false,
      message: 'WhatsApp is not ready yet',
      hasQR: !!qrCode,
      isAuthenticated: clientAuthenticated,
      instructions: 'Please wait for "WhatsApp is ready" message'
    });
  }
  next();
};

// **ROUTES**

// 1. Home Page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// 2. Status API
app.get("/status", (req, res) => {
  const status = {
    ready: clientReady,
    authenticated: clientAuthenticated,
    hasQR: !!qrCode,
    user: clientInfo?.pushname || null,
    phone: clientInfo?.me?.user || null,
    platform: clientInfo?.platform || null,
    sessionRestored: sessionRestored,
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  };
  
  res.json({
    success: true,
    data: status
  });
});

// 3. Send Message API
app.post("/send-message", [
  body("number").notEmpty().withMessage("Phone number is required"),
  body("message").notEmpty().withMessage("Message is required")
], checkClientReady, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }
    
    const { number, message } = req.body;
    
    // Format number
    const formatNumber = (num) => {
      let clean = num.toString().replace(/\D/g, '');
      if (clean.startsWith('0')) clean = clean.substring(1);
      if (clean.length === 10) clean = '91' + clean; // India country code
      return clean + '@c.us';
    };
    
    const formattedNumber = formatNumber(number);
    console.log(`📤 Sending message to ${formattedNumber}`);
    
    const sentMessage = await client.sendMessage(formattedNumber, message);
    
    res.json({
      success: true,
      message: "Message sent successfully",
      data: {
        messageId: sentMessage.id._serialized,
        timestamp: sentMessage.timestamp,
        to: formattedNumber
      }
    });
    
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({
      success: false,
      message: error.message,
      error: "Failed to send message"
    });
  }
});

// 4. Send Media API
app.post("/send-media", checkClientReady, async (req, res) => {
  try {
    if (!req.files || !req.files.media) {
      return res.status(400).json({
        success: false,
        message: "Media file is required"
      });
    }
    
    const { number, caption } = req.body;
    const mediaFile = req.files.media;
    
    const media = new MessageMedia(
      mediaFile.mimetype,
      mediaFile.data.toString('base64'),
      mediaFile.name
    );
    
    const formattedNumber = formatNumber(number);
    const sentMessage = await client.sendMessage(formattedNumber, media, { caption });
    
    res.json({
      success: true,
      message: "Media sent successfully"
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// 5. Get Chats
app.get("/chats", checkClientReady, async (req, res) => {
  try {
    const chats = await client.getChats();
    const chatList = chats.slice(0, 50).map(chat => ({
      id: chat.id._serialized,
      name: chat.name,
      isGroup: chat.isGroup,
      unreadCount: chat.unreadCount,
      lastMessage: chat.lastMessage?.body?.substring(0, 100)
    }));
    
    res.json({
      success: true,
      count: chatList.length,
      chats: chatList
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// 6. Get Contacts
app.get("/contacts", checkClientReady, async (req, res) => {
  try {
    const contacts = await client.getContacts();
    const contactList = contacts.slice(0, 100).map(contact => ({
      id: contact.id._serialized,
      name: contact.name || contact.pushname,
      number: contact.number,
      isBusiness: contact.isBusiness,
      isMyContact: contact.isMyContact
    }));
    
    res.json({
      success: true,
      count: contactList.length,
      contacts: contactList
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// 7. Restart WhatsApp
app.post("/restart", async (req, res) => {
  try {
    console.log('Restarting WhatsApp client...');
    
    clientReady = false;
    clientAuthenticated = false;
    
    await client.destroy();
    
    setTimeout(() => {
      initializeWhatsApp();
    }, 2000);
    
    res.json({
      success: true,
      message: "WhatsApp client restarting..."
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// 8. Clear Session
app.post("/clear-session", async (req, res) => {
  try {
    // Clear auth directory
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
      fs.mkdirSync(authDir, { recursive: true });
    }
    
    // Destroy client
    if (client.pupPage) {
      await client.destroy();
    }
    
    // Reset state
    clientReady = false;
    clientAuthenticated = false;
    qrCode = null;
    clientInfo = null;
    
    // Reinitialize
    setTimeout(() => {
      initializeWhatsApp();
    }, 3000);
    
    res.json({
      success: true,
      message: "Session cleared. Please scan QR code again."
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// 9. Test Connection
app.get("/test", checkClientReady, async (req, res) => {
  try {
    // Try to get battery status
    const battery = await client.info?.getBatteryStatus?.();
    
    res.json({
      success: true,
      message: "WhatsApp is connected and working",
      user: clientInfo?.pushname,
      phone: clientInfo?.me?.user,
      battery: battery,
      state: client.state
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Start Server
server.listen(port, () => {
  console.log(`
  ========================================
  🚀 WHATSAPP API SERVER
  ========================================
  📍 Local: http://localhost:${port}
  📍 Status: http://localhost:${port}/status
  📍 Test: http://localhost:${port}/test
  ========================================
  `);
});

// Handle process exit
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...');
  
  if (client.pupPage) {
    await client.destroy();
  }
  
  process.exit(0);
});