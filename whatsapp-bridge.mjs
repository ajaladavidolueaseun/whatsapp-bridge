import http from 'http';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import qrcodeTerminal from 'qrcode-terminal';

const PORT = process.env.PORT || 3000;
const AWAY_API_URL = process.env.AWAY_API_URL || 'https://ais-pre-5swwr4kuhq2phycj5cn37k-533452975787.europe-west2.run.app/api/respond';
const OWNER_NAME = process.env.OWNER_NAME || 'David';

let currentQR = null;
let isConnected = false;

// Simple health check server for Render free web service
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    service: 'WhatsApp Cloud Bridge',
    status: isConnected ? 'Connected & Protecting' : 'Waiting for QR scan in Render logs',
    owner: OWNER_NAME
  }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Listening on port ${PORT}`);
});

async function start() {
  console.log('[WhatsApp] Initializing connection...');
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ['Render Bridge', 'Chrome', '1.0']
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n========================================');
      console.log('SCAN THIS QR CODE WITH YOUR SAMSUNG A06:');
      console.log('WhatsApp -> (⋮) -> Linked Devices -> Link a Device');
      console.log('========================================\n');
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === 'close') {
      isConnected = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(`[WhatsApp] Disconnected. Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) setTimeout(start, 3000);
    } else if (connection === 'open') {
      isConnected = true;
      console.log('\n======================================================');
      console.log(' SUCCESS: Connected to active WhatsApp on Render!');
      console.log('Your Samsung A06 can now be completely turned OFF.');
      console.log('Auto-replies are 100% active in the cloud.');
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
