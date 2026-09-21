import http from 'http';
import makeWASocket, { 
  DisconnectReason, 
  useMultiFileAuthState, 
  fetchLatestBaileysVersion,
  Browsers 
} from '@whiskeysockets/baileys';
import qrcodeTerminal from 'qrcode-terminal';

const PORT = process.env.PORT || 3000;
const OWNER_NAME = process.env.OWNER_NAME || 'David';
const CURRENT_STATUS = process.env.CURRENT_STATUS || 'Away from phone';

let currentQR = null;
let isConnected = false;
const lastRepliedMap = new Map();
const COOLDOWN_MS = 10 * 60 * 1000; // 10-minute cooldown to avoid spamming the same contact

// ==========================================
// 1. SMART RESPONSE ENGINE (Zero External Dependencies)
// ==========================================
function generateAutoReply(message, senderName) {
  const lower = message.toLowerCase().trim();

  // Urgent detection
  if (
    lower.includes('urgent') ||
    lower.includes('emergency') ||
    lower.includes('asap') ||
    lower.includes('call me') ||
    lower.includes('hospital') ||
    lower.includes('immediately') ||
    lower.includes('quick call')
  ) {
    return `Hi! I'm ${OWNER_NAME}'s personal assistant. I've flagged your message as high priority for them. Please leave any important details here so they can respond the moment they pick up their phone!`;
  }

  // Question or favor detection
  if (
    lower.includes('?') ||
    lower.includes('can you') ||
    lower.includes('could you') ||
    lower.includes('what time') ||
    lower.includes('where is') ||
    lower.includes('do you know') ||
    lower.includes('help me') ||
    lower.includes('favor')
  ) {
    return `Hey ${senderName}! I'm ${OWNER_NAME}'s AI assistant. They're currently ${CURRENT_STATUS.toLowerCase()}, but I've saved your question for them. They will text you back with the details as soon as they're back online!`;
  }

  // Casual greeting / check-in
  return `Hey ${senderName}! I'm ${OWNER_NAME}'s personal AI assistant. They're ${CURRENT_STATUS.toLowerCase()} right now, but I'll make sure they see your message as soon as they check WhatsApp!`;
}

// Extracts text from all possible WhatsApp message types
function extractMessageText(msg) {
  if (!msg.message) return null;
  const m = msg.message;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.ephemeralMessage?.message?.conversation ||
    m.ephemeralMessage?.message?.extendedTextMessage?.text ||
    m.viewOnceMessage?.message?.conversation ||
    m.viewOnceMessage?.message?.extendedTextMessage?.text ||
    null
  );
}

// ==========================================
// 2. HTTP SERVER FOR RENDER HEALTH CHECK & QR
// ==========================================
const server = http.createServer((req, res) => {
  if (req.url === '/qr') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (isConnected) {
      return res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>WhatsApp Cloud Bridge</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body style="font-family:system-ui,sans-serif;padding:40px;text-align:center;background:#0f172a;color:#22c55e">
          <h2>✅ Connected to WhatsApp!</h2>
          <p style="color:#cbd5e1">Your Samsung A06 can now be turned completely OFF.</p>
          <p style="color:#94a3b8;font-size:13px">Cloud Auto-Responder is actively monitoring incoming messages.</p>
        </body>
        </html>
      `);
    }
    if (!currentQR) {
      return res.end(`
        <!DOCTYPE html>
        <html>
        <head><meta http-equiv="refresh" content="3"><title>WhatsApp Bridge</title></head>
        <body style="font-family:system-ui,sans-serif;padding:40px;text-align:center;background:#0f172a;color:#f8fafc">
          <h2>Generating Fresh WhatsApp QR...</h2>
          <p>Please wait 3 seconds...</p>
        </body>
        </html>
      `);
    }
    const qrImg = `https://api.qrserver.com/v1/create-qr-code/?size=350x350&data=${encodeURIComponent(currentQR)}`;
    return res.end(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta http-equiv="refresh" content="18">
        <title>Scan WhatsApp QR</title>
      </head>
      <body style="background:#0f172a;color:#f8fafc;font-family:system-ui,sans-serif;padding:30px;text-align:center">
        <h2>Link Your WhatsApp</h2>
        <p style="color:#94a3b8;margin-bottom:20px">Scan immediately when the image appears:</p>
        <div style="background:#fff;padding:16px;border-radius:16px;display:inline-block;box-shadow:0 10px 30px rgba(0,0,0,0.5)">
          <img src="${qrImg}" style="width:300px;height:300px;display:block" />
        </div>
        <p style="color:#64748b;font-size:12px;margin-top:16px">Refreshes every 18 seconds</p>
      </body>
      </html>
    `);
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    service: 'WhatsApp Cloud Bridge',
    connected: isConnected,
    owner: OWNER_NAME,
    status: CURRENT_STATUS
  }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Render Web Service] Listening on port ${PORT}`);
});

// ==========================================
// 3. WHATSAPP CONNECTION (BAILEYS)
// ==========================================
async function startWhatsAppBridge() {
  console.log('[WhatsApp] Initializing connection state...');
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.macOS('Desktop'),
    syncFullHistory: false
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      console.log('\n[NEW QR CODE GENERATED - View on /qr or terminal]');
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === 'close') {
      isConnected = false;
      const statusCode = (lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`[WhatsApp] Connection closed (code ${statusCode}). Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(startWhatsAppBridge, 3000);
      } else {
        console.log('[WhatsApp] Logged out. Restart service to pair again.');
      }
    } else if (connection === 'open') {
      isConnected = true;
      currentQR = null;
      console.log('\n======================================================');
      console.log(' SUCCESS: Connected to active WhatsApp on Render!');
      console.log(' Your Samsung A06 can now be completely turned OFF.');
      console.log(' Cloud auto-responder is ready to receive messages.');
      console.log('======================================================\n');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Message Listener
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      // Ignore messages sent by you from your phone
      if (msg.key.fromMe) {
        lastRepliedMap.set(msg.key.remoteJid, Date.now());
        continue;
      }

      // Ignore group chats
      if (msg.key.remoteJid.endsWith('@g.us')) {
        continue;
      }

      const incomingText = extractMessageText(msg);
      if (!incomingText || !incomingText.trim()) {
        continue;
      }

      const senderJid = msg.key.remoteJid;
      const senderName = msg.pushName || 'Friend';

      console.log(`\n📩 [INCOMING MESSAGE] from ${senderName}: "${incomingText}"`);

      // Cooldown check (prevent repeated replies to same person within 10 minutes)
      const lastReplied = lastRepliedMap.get(senderJid) || 0;
      if (Date.now() - lastReplied < COOLDOWN_MS) {
        console.log(`⏳ [Cooldown Active] Already replied to ${senderName} recently. Skipping.`);
        continue;
      }

      // Generate the response
      const replyText = generateAutoReply(incomingText, senderName);
      console.log(`🤖 [GENERATED REPLY] for ${senderName}: "${replyText}"`);

      try {
        // Human-like typing delay (1.5 seconds)
        await sock.sendPresenceUpdate('composing', senderJid);
        await new Promise((r) => setTimeout(r, 1500));
        await sock.sendPresenceUpdate('paused', senderJid);

        // Send WhatsApp reply
        await sock.sendMessage(senderJid, { text: replyText });
        lastRepliedMap.set(senderJid, Date.now());
        console.log(`✅ [REPLY DELIVERED SUCCESSFULLY] to ${senderName}!\n`);
      } catch (err) {
        console.error('❌ [Error sending WhatsApp reply]:', err);
      }
    }
  });
}

startWhatsAppBridge();
