import http from 'http';
import makeWASocket, { 
  DisconnectReason, 
  useMultiFileAuthState, 
  fetchLatestBaileysVersion,
  Browsers 
} from '@whiskeysockets/baileys';
import qrcodeTerminal from 'qrcode-terminal';

const PORT = process.env.PORT || 3000;
const AWAY_API_URL = process.env.AWAY_API_URL || 'https://ais-pre-5swwr4kuhq2phycj5cn37k-533452975787.europe-west2.run.app/api/respond';
const OWNER_NAME = process.env.OWNER_NAME || 'David';

let currentQR = null;
let isConnected = false;

// HTTP server for easy browser scanning & Render health check
const server = http.createServer((req, res) => {
  if (req.url === '/qr') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (isConnected) {
      return res.end('<body style="background:#0f172a;color:#22c55e;font-family:sans-serif;padding:40px;text-align:center"><h2>✅ Connected to WhatsApp!</h2><p style="color:#cbd5e1">Your Samsung A06 can now be turned completely OFF.</p></body>');
    }
    if (!currentQR) {
      return res.end('<body style="background:#0f172a;color:#f8fafc;font-family:sans-serif;padding:40px;text-align:center"><meta http-equiv="refresh" content="3"><h2>Generating Fresh WhatsApp QR...</h2><p>Auto-refreshing in 3 seconds...</p></body>');
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
    status: isConnected ? 'Connected & Protecting' : 'Visit /qr to scan QR in your browser',
    owner: OWNER_NAME
  }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Listening on port ${PORT}`);
});

async function start() {
  console.log('[WhatsApp] Fetching latest WhatsApp version...');
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
      console.log('\n[NEW FRESH QR CODE GENERATED]\n');
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === 'close') {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`[WhatsApp] Disconnected (code ${statusCode}). Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(start, 3000);
      }
    } else if (connection === 'open') {
      isConnected = true;
      currentQR = null;
      console.log('\n======================================================');
      console.log(' SUCCESS: Connected to active WhatsApp on Render!');
      console.log('Your Samsung A06 can now be completely turned OFF.');
      console.log('======================================================\n');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe || msg.key.remoteJid.endsWith('@g.us')) continue;

      const incomingText = msg.message.conversation || msg.message.extendedTextMessage?.text;
      if (!incomingText || !incomingText.trim()) continue;

      const senderJid = msg.key.remoteJid;
      const senderName = msg.pushName || 'Contact';

      console.log(`[Incoming] from ${senderName}: "${incomingText}"`);

      try {
        const res = await fetch(AWAY_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: incomingText,
            sender: senderName,
            ownerName: OWNER_NAME,
            currentStatus: 'Away from phone'
          })
        });

        const data = await res.json();
        const replyText = data.finalReply || data.reply;

        if (replyText) {
          await sock.sendMessage(senderJid, { text: replyText });
          console.log(`[Auto-Reply Sent] to ${senderName}: "${replyText}"`);
        }
      } catch (err) {
        console.error('[Error processing message]:', err);
      }
    }
  });
}

start();
