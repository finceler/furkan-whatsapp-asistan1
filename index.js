const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

let latestQR = '';
let isConnected = false;

// Basit konuşma hafızası (Son 10 mesajı tutar)
const chatHistory = new Map();

// ASİSTANIN KARAKTERİ VE KURALLARI
const SYSTEM_INSTRUCTION = `
Sen Furkan İnceler'in kişisel dijital asistanısın. 
Şu an Furkan Bey müsait değil. Gelen mesajlara kibar, profesyonel, kısa ve net Türkçe ile yanıt ver.

Görevlerin:
1. Karşı tarafa şu an Furkan Bey'in müsait olmadığını, kendisinin en kısa sürede dönüş yapacağını belirt ve varsa iletmek istedikleri notu sor.
2. Eğer karşı taraf bir görüşme veya randevu talep ederse:
   - Görüşme konusunu, tercih ettikleri günü ve saat aralığını sor.
   - Furkan Bey'in hafta içi 18:00 sonrası ve hafta sonları daha esnek olduğunu, gündüz saatlerinde ise uygunluk durumuna göre dönüş yapılacağını nazikçe ilet.
3. Gereksiz uzun cümleler kurma, samimi ama saygılı ol (Örn: "Merhaba, ben Furkan Bey'in dijital asistanıyım...").
4. Asla yapay zeka olduğunu gizleme ama robotik de konuşma.
`;

// Groq Aktif Modeli Otomatik Seçer ve Yanıt Üretir
async function askGemini(history) {
  const modelsRes = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { 'Authorization': `Bearer ${GEMINI_API_KEY}` }
  });
  const modelsData = await modelsRes.json();
  const availableModels = (modelsData.data || []).map(m => m.id).filter(id => !id.includes('whisper') && !id.includes('guard'));
  const selectedModel = availableModels.find(id => id.includes('llama') || id.includes('gpt') || id.includes('qwen')) || availableModels[0] || 'llama-3.1-8b-instant';

  const messages = [
    { role: 'system', content: SYSTEM_INSTRUCTION },
    ...history.map(m => ({
      role: m.role === 'model' ? 'assistant' : 'user',
      content: m.parts[0].text
    }))
  ];

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GEMINI_API_KEY}`
    },
    body: JSON.stringify({
      model: selectedModel,
      messages: messages,
      temperature: 0.7
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(JSON.stringify(data));
  }
  return data.choices?.[0]?.message?.content || 'Şu an yanıt oluşturulamadı, notunuzu ileteceğim.';
}

// QR Kodu Tarayıcıdan Göstermek İçin Web Arayüzü
app.get('/', async (req, res) => {
  if (isConnected) {
    return res.send('<h2>✅ Furkan Bey WhatsApp Asistanı Aktif ve Bağlı!</h2>');
  }
  if (!latestQR) {
    return res.send('<h2>⏳ QR Kod oluşturuluyor, lütfen 5 saniye sonra sayfayı yenileyin...</h2>');
  }
  const qrImage = await QRCode.toDataURL(latestQR);
  res.send(`
    <div style="text-align:center; font-family:sans-serif; margin-top:50px;">
      <h2>WhatsApp Business -> Bağlı Cihazlar -> Cihaz Bağla</h2>
      <img src="${qrImage}" style="width:300px; height:300px;" />
      <p>Kodu okuttuktan sonra sayfayı yenileyin.</p>
    </div>
  `);
});

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Furkan Asistan', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      latestQR = qr;
      isConnected = false;
    }
    if (connection === 'close') {
      isConnected = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      isConnected = true;
      latestQR = '';
      console.log('WhatsApp bağlantısı başarılı!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    if (sender.endsWith('@g.us') || sender === 'status@broadcast') return;

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
    if (!text) return;

    try {
      const history = chatHistory.get(sender) || [];
      history.push({ role: 'user', parts: [{ text }] });
      if (history.length > 10) history.shift();

      const replyText = await askGemini(history);

      history.push({ role: 'model', parts: [{ text: replyText }] });
      chatHistory.set(sender, history);

      await sock.sendMessage(sender, { text: replyText });
    } catch (err) {
      console.error('Mesaj yanıtlanırken hata:', err);
    }
  });
}

app.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda çalışıyor.`);
  startBot();
});
