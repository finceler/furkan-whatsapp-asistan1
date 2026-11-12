const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FURKAN_PHONE = (process.env.FURKAN_PHONE || '').replace(/\D/g, '');

let latestQR = '';
let isConnected = false;

const chatHistory = new Map();

// =========================================================================
// 2026 MBB KEVSK KURUL TAKVİMİ (Tarsus - Uzak İlçeler Dahil)
// =========================================================================
const KURUL_TAKVIMI_2026 = [
  { no: 1,  sonTeslim: '2026-01-09', uzakAlt: '2026-01-15', ilanReklam: '2026-01-15', kevsk: '2026-01-15' },
  { no: 2,  sonTeslim: '2026-01-23', uzakAlt: '2026-01-29', ilanReklam: '2026-01-29', kevsk: '2026-01-29' },
  { no: 3,  sonTeslim: '2026-02-06', uzakAlt: '2026-02-12', ilanReklam: '2026-02-12', kevsk: '2026-02-12' },
  { no: 4,  sonTeslim: '2026-02-20', uzakAlt: '2026-02-26', ilanReklam: '2026-02-26', kevsk: '2026-02-26' },
  { no: 5,  sonTeslim: '2026-03-06', uzakAlt: '2026-03-12', ilanReklam: '2026-03-12', kevsk: '2026-03-12' },
  { no: 6,  sonTeslim: '2026-03-18', uzakAlt: '2026-03-26', ilanReklam: '2026-03-26', kevsk: '2026-03-26' },
  { no: 7,  sonTeslim: '2026-04-10', uzakAlt: '2026-04-16', ilanReklam: '2026-04-16', kevsk: '2026-04-16' },
  { no: 8,  sonTeslim: '2026-04-24', uzakAlt: '2026-04-30', ilanReklam: '2026-04-29', kevsk: '2026-04-30' },
  { no: 9,  sonTeslim: '2026-05-08', uzakAlt: '2026-05-14', ilanReklam: '2026-05-13', kevsk: '2026-05-14' },
  { no: 10, sonTeslim: '2026-06-05', uzakAlt: '2026-06-11', ilanReklam: '2026-06-10', kevsk: '2026-06-11' },
  { no: 11, sonTeslim: '2026-06-19', uzakAlt: '2026-06-25', ilanReklam: '2026-06-24', kevsk: '2026-06-25' },
  { no: 12, sonTeslim: '2026-07-03', uzakAlt: '2026-07-09', ilanReklam: '2026-07-08', kevsk: '2026-07-09' },
  { no: 13, sonTeslim: '2026-07-17', uzakAlt: '2026-07-23', ilanReklam: '2026-07-22', kevsk: '2026-07-23' },
  { no: 14, sonTeslim: '2026-08-07', uzakAlt: '2026-08-13', ilanReklam: '2026-08-12', kevsk: '2026-08-13' },
  { no: 15, sonTeslim: '2026-08-21', uzakAlt: '2026-08-27', ilanReklam: '2026-08-26', kevsk: '2026-08-27' },
  { no: 16, sonTeslim: '2026-09-04', uzakAlt: '2026-09-10', ilanReklam: '2026-09-09', kevsk: '2026-09-10' },
  { no: 17, sonTeslim: '2026-09-18', uzakAlt: '2026-09-24', ilanReklam: '2026-09-23', kevsk: '2026-09-24' },
  { no: 18, sonTeslim: '2026-10-02', uzakAlt: '2026-10-08', ilanReklam: '2026-10-07', kevsk: '2026-10-08' },
  { no: 19, sonTeslim: '2026-10-16', uzakAlt: '2026-10-22', ilanReklam: '2026-10-21', kevsk: '2026-10-22' },
  { no: 20, sonTeslim: '2026-11-06', uzakAlt: '2026-11-12', ilanReklam: '2026-11-11', kevsk: '2026-11-12' },
  { no: 21, sonTeslim: '2026-11-20', uzakAlt: '2026-11-26', ilanReklam: '2026-11-25', kevsk: '2026-11-26' },
  { no: 22, sonTeslim: '2026-12-04', uzakAlt: '2026-12-10', ilanReklam: '2026-12-09', kevsk: '2026-12-10' },
  { no: 23, sonTeslim: '2026-12-21', uzakAlt: '2026-12-30', ilanReklam: '2026-12-29', kevsk: '2026-12-30' }
];

function formatTRDate(isoStr) {
  const [y, m, d] = isoStr.split('-');
  return `${d}.${m}.${y}`;
}

function getKevskBilgiMesaji() {
  const bugunStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' });
  const siradaki = KURUL_TAKVIMI_2026.find(k => k.kevsk >= bugunStr) || KURUL_TAKVIMI_2026[KURUL_TAKVIMI_2026.length - 1];
  const teslimGectiMi = bugunStr > siradaki.sonTeslim;
  const sonrakiTeslim = teslimGectiMi
    ? (KURUL_TAKVIMI_2026.find(k => k.sonTeslim >= bugunStr) || siradaki)
    : siradaki;

  return `🏛️ *MBB KEVSKK (Kent Estetiği Kurulu) Bilgilendirme*\n\n` +
    `📅 *En Yakın Kurul Bilgisi (${siradaki.no}. Kurul):*\n` +
    `• *Son Teslim Tarihi (Tarsus Bld. İmar ve Şehircilik Müd.):* ${formatTRDate(siradaki.sonTeslim)}${teslimGectiMi ? ` _(Bu kurulun teslim süresi doldu; bir sonraki ${sonrakiTeslim.no}. Kurul son teslim tarihi: *${formatTRDate(sonrakiTeslim.sonTeslim)}*)_` : ''}\n` +
    `• *Tarsus (Uzak İlçeler) Alt Kurul Tarihi:* ${formatTRDate(siradaki.uzakAlt)} (Saat 13:00)\n` +
    `• *İlan Reklam Tabela Alt Kurul Tarihi:* ${formatTRDate(siradaki.ilanReklam)} (Saat 15:00)\n` +
    `• *KEVSK Ana Kurul Tarihi:* ${formatTRDate(siradaki.kevsk)} (Saat 15:30)\n\n` +
    `⚠️ *Önemli Teslim Uyarısı:* Belirtilen son teslim tarihi, evrakların Tarsus Belediyesi İmar ve Şehircilik Müdürlüğü'ne teslim edilmesi gereken en son tarihtir. Projelerin oluşabilecek yoğunluğu göz önünde bulundurularak evrakların *son teslim tarihinden birkaç gün önce* getirilmesi gerekmektedir.\n\n` +
    `📂 *DOSYALAMA SİSTEMİ (Sırasıyla):*\n` +
    `1 : Başvuru Dilekçesi\n` +
    `2 : Başvuran İletişim Bilgileri (Proje Başvuru Formu)\n` +
    `3 : Tapu Belgesi\n` +
    `4 : İmar Durum Belgesi\n` +
    `5 : İlçe Belediyesi Üst Yazısı\n` +
    `6 : İlçe Belediyesi Onaylı Mimari Proje\n` +
    `7 : Peyzaj Projesi\n` +
    `8 : Arazi Uydu Görüntüsü\n` +
    `9 : Arazi Resimleri\n` +
    `10 : Renderlar (3D Görsel)\n` +
    `11 : Açıklama Raporu\n` +
    `12 : Proje Kontrol Formu (Proje Müellifince doldurulacaktır)\n\n` +
    `✍️ *Form Doldurma Kuralı:*\n` +
    `MBB KEVSKK Proje Kontrol ve Başvuru dosyasında *Proje Kontrol* sayfası mimar tarafından doldurulacaktır. *Proje Başvuru* kısmında ise *Mimar Bilgileri* ile *Parsel ve Malik Bilgileri* yine mimar tarafından doldurulacaktır.\n\n` +
    `📎 _İlgili kurul takvimi ve başvuru/kontrol Excel dosyaları ekte gönderilmektedir._`;
}

// =========================================================================
// TETİKLEYİCİ ANAHTAR KELİMELER
// =========================================================================
const TETIKLEYICI_KELIMELER = ['kurul', 'kurul tarihi', 'kent estetiği', 'kent estetigi', 'kevsk', 'kevskk'];

// =========================================================================
// YAPAY ZEKA BİLGİ BANKASI
// =========================================================================
const BILGI_BANKASI = `
- Furkan İnceler, Tarsus Belediyesi İmar ve Şehircilik Müdürlüğü bünyesinde CBS ve Kent Estetiği (KEVSKK) süreçleri konusunda görev yapmaktadır.
- Tarsus, MBB KEVSKK takviminde "Uzak İlçeler" kategorisindedir (Uzak İlçeler Alt Kurul saati: 13:00, İlan Reklam Tabela Alt Kurul saati: 15:00, KEVSK Kurul saati: 15:30).
- Yaklaşan 2026 Kurul Tarihleri:
  * 21. Kurul: Son Teslim 20.11.2026 | Tarsus Alt Kurul 26.11.2026 | İlan Reklam 25.11.2026 | KEVSK Kurul 26.11.2026
  * 22. Kurul: Son Teslim 04.12.2026 | Tarsus Alt Kurul 10.12.2026 | İlan Reklam 09.12.2026 | KEVSK Kurul 10.12.2026
  * 23. Kurul: Son Teslim 21.12.2026 | Tarsus Alt Kurul 30.12.2026 | İlan Reklam 29.12.2026 | KEVSK Kurul 30.12.2026
- Son teslim tarihi Tarsus Belediyesi İmar ve Şehircilik Müdürlüğü'ne teslim edilmesi gereken en son tarihtir; yoğunluk nedeniyle birkaç gün öncesinde getirilmesi gerekir.
- 12 Maddelik Dosyalama Sistemi: 1: Başvuru Dilekçesi, 2: Başvuran İletişim Bilgileri (Proje Başvuru Formu), 3: Tapu Belgesi, 4: İmar Durum Belgesi, 5: İlçe Belediyesi Üst Yazısı, 6: İlçe Belediyesi Onaylı Mimari Proje, 7: Peyzaj Projesi, 8: Arazi Uydu Görüntüsü, 9: Arazi Resimleri, 10: Renderlar (3D Görsel), 11: Açıklama Raporu, 12: Proje Kontrol Formu (Proje Müellifince doldurulacaktır).
- Form Doldurma: MBB KEVSKK Proje Kontrol ve Başvuru dosyasında Proje Kontrol sayfası mimar tarafından doldurulacaktır. Proje Başvuru kısmında mimar bilgileri ve parsel ile malik bilgileri mimar tarafından doldurulacaktır.
`;

const SYSTEM_INSTRUCTION = `
Sen Furkan İnceler'in kişisel dijital asistanısın. 
Şu an Furkan Bey müsait değil. Gelen mesajlara kibar, profesyonel, kısa ve net Türkçe ile yanıt ver.

Bilgi Bankan:
${BILGI_BANKASI}

Görevlerin:
1. Karşı taraf Kent Estetiği, kurul tarihi, evrak listesi veya dosyalama hakkında soru sorarsa Bilgi Bankasındaki kesin bilgileri paylaş.
2. Karşı tarafa şu an Furkan Bey'in müsait olmadığını, en kısa sürede dönüş yapacağını belirt ve varsa ada/parsel numarasını veya iletmek istedikleri notu sor.
3. Randevu veya görüşme talebi olursa konusunu, tercih ettikleri günü ve saati sor; Furkan Bey'in hafta içi 18:00 sonrası ve hafta sonları daha esnek olduğunu belirt.

ÖNEMLİ BİLDİRİM KURALI:
Eğer kullanıcı iletmek istediği somut bir not paylaştıysa, ada/parsel bilgisi verdiyse VEYA görüşme için gün/saat bilgisi verdiyse, cevabının EN SONUNA şu gizli etiketi ekle:
[[BILDIRIM: Kişinin adı (biliniyorsa) | Konu / Randevu Talebi | İletilecek Kısa Özet]]
Genel bilgi sorularında bu etiketi EKLEME.
`;

// Dizindeki tüm Excel (.xls / .xlsx) ve PDF dosyalarını otomatik bulup WhatsApp'tan gönderir
async function sendKevskDocuments(sock, jid) {
  try {
    const allFiles = fs.readdirSync(__dirname);
    const excelAndPdfFiles = allFiles.filter(f => /\.(xlsx|xls|pdf)$/i.test(f));

    for (const fileName of excelAndPdfFiles) {
      const filePath = path.join(__dirname, fileName);
      const ext = path.extname(fileName).toLowerCase();
      let mimetype = 'application/octet-stream';

      if (ext === '.xlsx') {
        mimetype = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      } else if (ext === '.xls') {
        mimetype = 'application/vnd.ms-excel';
      } else if (ext === '.pdf') {
        mimetype = 'application/pdf';
      }

      await sock.sendMessage(jid, {
        document: fs.readFileSync(filePath),
        fileName: fileName,
        mimetype: mimetype
      });
    }
  } catch (err) {
    console.error('Excel/PDF dosyaları gönderilirken hata:', err);
  }
}

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
      temperature: 0.4
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(JSON.stringify(data));
  }
  return data.choices?.[0]?.message?.content || 'Şu an yanıt oluşturulamadı, notunuzu ileteceğim.';
}

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

    const senderNumber = sender.split('@')[0];
    const senderName = msg.pushName || 'Bilinmeyen Kişi';

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
    if (!text) return;

    try {
      const lowerText = text.toLocaleLowerCase('tr-TR');

      // 1. Anahtar Kelime Kontrolü: "Kurul", "Kurul tarihi", "Kent estetiği"
      const isKevskQuery = TETIKLEYICI_KELIMELER.some(k => lowerText.includes(k));

      if (isKevskQuery) {
        const bilgiMesaji = getKevskBilgiMesaji();
        await sock.sendMessage(sender, { text: bilgiMesaji });
        await sendKevskDocuments(sock, sender);
        return;
      }

      // 2. Diğer mesajlar için Yapay Zeka devreye girer
      const history = chatHistory.get(sender) || [];
      history.push({ role: 'user', parts: [{ text }] });
      if (history.length > 10) history.shift();

      let rawReply = await askGemini(history);

      let notificationSummary = null;
      const notifyMatch = rawReply.match(/\[\[BILDIRIM:\s*(.*?)\]\]/s);
      if (notifyMatch) {
        notificationSummary = notifyMatch[1].trim();
        rawReply = rawReply.replace(/\[\[BILDIRIM:\s*.*?\]\]/s, '').trim();
      }

      history.push({ role: 'model', parts: [{ text: rawReply }] });
      chatHistory.set(sender, history);

      await sock.sendMessage(sender, { text: rawReply });

      if (notificationSummary && FURKAN_PHONE && senderNumber !== FURKAN_PHONE) {
        const furkanJid = `${FURKAN_PHONE}@s.whatsapp.net`;
        const alertText =
          `🔔 *Yeni Asistan Bildirimi*\n\n` +
          `👤 *Gönderen:* ${senderName} (+${senderNumber})\n` +
          `📋 *Detay:* ${notificationSummary}\n` +
          `💬 *Son Mesaj:* "${text}"`;

        await sock.sendMessage(furkanJid, { text: alertText });
      }
    } catch (err) {
      console.error('Mesaj yanıtlanırken hata:', err);
    }
  });
}

app.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda çalışıyor.`);
  startBot();
});
