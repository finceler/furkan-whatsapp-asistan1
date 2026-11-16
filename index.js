const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;

// Çevre Değişkenleri (Railway Variables)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OWNER_NUMBER = '905309455371@s.whatsapp.net'; // KENDİ NUMARANI BURAYA YAZ (Başında + olmadan, sonu @s.whatsapp.net)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'furkan123';

let qrCodeData = null;
let connectionStatus = 'Bağlantı bekleniyor...';

// Kullanıcı bazlı kısa süreli sohbet hafızası (Doğal AI sohbeti için)
const chatHistories = new Map();

// Gerçek telefon numarasını ayıklama fonksiyonu (LID sorununu çözer)
function extractRealPhoneNumber(msg) {
    const key = msg.key;
    // Baileys yeni sürümlerde gerçek numarayı senderPn veya remoteJidAlt içinde tutar
    const rawJid = key.senderPn || key.remoteJidAlt || key.participant || key.remoteJid || '';
    const digits = rawJid.split('@')[0].split(':')[0].replace(/\D/g, '');
    
    if (digits.startsWith('90') && digits.length === 12) {
        return `+${digits}`;
    } else if (digits.length >= 10) {
        return `+${digits}`;
    }
    return rawJid.split('@')[0];
}

// Mesai saati kontrolü (Türkiye saati UTC+3, Hafta içi 08:30 - 17:30)
function isOutOfOffice() {
    const now = new Date();
    const trTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Istanbul' }));
    const day = trTime.getDay(); // 0: Pazar, 6: Cumartesi
    const hour = trTime.getHours();
    const minute = trTime.getMinutes();
    const totalMinutes = hour * 60 + minute;

    if (day === 0 || day === 6) return true;
    if (totalMinutes < 8 * 60 + 30 || totalMinutes > 17 * 60 + 30) return true;
    return false;
}

// Gemini AI Yanıt Üretici
async function askGemini(userId, senderName, realPhone, userMessage) {
    if (!GEMINI_API_KEY) {
        return 'Sistem yapılandırması devam ediyor (API anahtarı eksik). Lütfen daha sonra tekrar deneyin.';
    }

    if (!chatHistories.has(userId)) {
        chatHistories.set(userId, []);
    }
    const history = chatHistories.get(userId);

    const systemInstruction = `
Sen Furkan İnceler'in (Furkan Bey) profesyonel, kibar, zeki ve doğal konuşan yapay zeka WhatsApp asistanısın.
Kullanıcılarla tıpkı gerçek bir yapay zeka (Gemini) gibi akıcı, samimi ama saygılı bir dille sohbet et. Genel kültür, teknik konular, günlük sohbet veya merak ettikleri her konuda yardımcı ol.

Ayrıca Furkan Bey'in iş süreçleri hakkında şu bilgilere hakimsin:
1. KURUMSAL GÖREVLER (Tarsus Belediyesi İmar ve Şehircilik Müdürlüğü & MBB KEVSKK):
   - Mersin Büyükşehir Belediyesi (MBB) Kent Estetiği ve Sanat Komisyonu (KEVSKK) kurul tarihleri ve proje teslim süreçleri hakkında bilgi verebilirsin.
   - KEVSKK / Belediye Proje Başvurusu İçin 12 Maddelik Evrak Kontrol Listesi:
     1) Başvuru Dilekçesi
     2) İletişim Bilgileri / Proje Başvuru Formu
     3) Tapu Belgesi (Güncel)
     4) İmar Durum Belgesi
     5) İlçe Belediyesi Üst Yazısı
     6) Onaylı Mimari Proje
     7) Peyzaj Projesi
     8) Arazi Uydu Görüntüsü
     9) Arazi Resimleri (Güncel saha fotoğrafları)
     10) 3D Renderlar (Görselleştirmeler)
     11) Açıklama Raporu
     12) Proje Kontrol Formu
   Kullanıcı evrakları sorarsa bu listeyi düzenli şekilde paylaş veya sorduğu evrakla ilgili açıklama yap.

2. TARSUS MAHALLE HAVA DURUMU:
   - Kullanıcı Tarsus veya mahalleleri (Bahşiş, Beydeğirmeni, Ünlüköy, Boztepe, Gülek, Çamlıyayla vb.) hakkında hava durumu sorarsa kendi genel meteorolojik bilgin ve güncel mevsim koşullarına göre yardımcı ol.

3. RANDEVU VE ACİL DURUM YÖNETİMİ:
   - Kullanıcı "randevu" almak veya Furkan Bey ile görüşmek istediğini söylerse: Eğer henüz Ad-Soyad ve Görüşme Konusunu yazmadıysa, nazikçe Adını Soyadını ve görüşmek istediği konuyu sor.
   - Kullanıcı Ad-Soyad ve Konu bilgisini verdiğinde randevu talebinin alındığını onayla.

4. BİLDİRİM TETİKLEYİCİ (ÇOK ÖNEMLİ):
   - Eğer mesajda:
     a) Kullanıcı randevu için Ad-Soyad ve konu bilgisini tamamladıysa,
     b) Mesajda "ACİL" veya çok acil bir durum varsa,
     c) Önemli bir belediye/proje evrak teslimi talebi iletildiyse,
   Yanıtının EN SONUNA şu gizli etiketi ekle (kullanıcı bunu görmeyecek, sistem yakalayacak):
   [BILDIRIM: Kategori | Kısa Özet]
   Örnek: [BILDIRIM: Randevu Talebi | Ahmet Yılmaz - İmar durumu ve mimari proje görüşmesi]
   Eğer sadece normal sohbet ediliyorsa veya kullanıcı henüz randevu detaylarını (ad/konu) vermediyse bu etiketi EKLEME.
`;

    history.push({
        role: 'user',
        parts: [{ text: `Gönderen Adı: ${senderName} (${realPhone})\nMesaj: ${userMessage}` }]
    });

    // Hafızayı son 10 mesajla sınırla
    if (history.length > 10) {
        history.splice(0, history.length - 10);
    }

    try {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    system_instruction: { parts: [{ text: systemInstruction }] },
                    contents: history,
                    generationConfig: {
                        temperature: 0.7,
                        maxOutputTokens: 800
                    }
                })
            }
        );

        const data = await response.json();
        let replyText = data?.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!replyText) {
            return 'Şu an mesajınızı işlerken kısa bir gecikme yaşadım, tekrar yazar mısınız?';
        }

        history.push({
            role: 'model',
            parts: [{ text: replyText }]
        });

        return replyText;
    } catch (error) {
        console.error('Gemini API Hatası:', error);
        return 'Şu an yapay zeka servisine bağlanırken geçici bir sorun oluştu, biraz sonra tekrar deneyebilirsiniz.';
    }
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ['Furkan Bey Asistan', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCodeData = await QRCode.toDataURL(qr);
            connectionStatus = 'QR Kod hazır. Lütfen okutun.';
        }

        if (connection === 'close') {
            qrCodeData = null;
            const shouldReconnect =
                lastDisconnect?.error instanceof Boom
                    ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                    : true;

            connectionStatus = 'Bağlantı koptu, yeniden bağlanılıyor...';
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            qrCodeData = null;
            connectionStatus = 'WhatsApp Asistanı Aktif ve Bağlı ✅';
            console.log('WhatsApp bağlantısı başarılı!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        // Grup mesajlarını ve durum güncellemelerini yoksay
        if (remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') return;

        const text =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            '';

        if (!text.trim()) return;

        const senderName = msg.pushName || 'İsimsiz Kullanıcı';
        const realPhone = extractRealPhoneNumber(msg);

        console.log(`Yeni mesaj [${senderName} - ${realPhone}]: ${text}`);

        // Yazıyor... efekti göster
        await sock.sendPresenceUpdate('composing', remoteJid);

        let aiResponse = await askGemini(remoteJid, senderName, realPhone, text);

        // Gizli bildirim etiketini kontrol et
        const notificationMatch = aiResponse.match(/\[BILDIRIM:\s*(.*?)\]/i);
        let notificationDetail = null;

        if (notificationMatch) {
            notificationDetail = notificationMatch[1].trim();
            // Kullanıcının göreceği mesajdan etiketi temizle
            aiResponse = aiResponse.replace(/\[BILDIRIM:\s*.*?\]/gi, '').trim();
        }

        // Mesai dışı bilgisi ekle (Sadece sohbetin ilk mesajında veya randevu/acil durumunda)
        const isFirstMessage = (chatHistories.get(remoteJid)?.length || 0) <= 2;
        if (isOutOfOffice() && (isFirstMessage || notificationDetail)) {
            aiResponse += `\n\n_Not: Şu an mesai saatleri dışındayız. Acil bir durum varsa mesajınızda *ACİL* belirtmeniz yeterlidir._`;
        }

        // Kullanıcıya yanıtı gönder
        await sock.sendMessage(remoteJid, { text: aiResponse });
        await sock.sendPresenceUpdate('paused', remoteJid);

        // Eğer randevu tamamlandıysa veya mesajda ACİL geçiyorsa sana bildirim at
        const isUrgent = text.toLocaleLowerCase('tr-TR').includes('acil');
        if ((notificationDetail || isUrgent) && OWNER_NUMBER.includes('905')) {
            const detailText = notificationDetail || 'Acil Mesaj Bildirimi';
            const ownerAlert =
                `🔔 *Yeni Asistan Bildirimi*\n\n` +
                `👤 *Gönderen:* ${realPhone} (${senderName})\n` +
                `📋 *Detay:* ${detailText}\n` +
                `💬 *Son Mesaj:* "${text}"`;

            await sock.sendMessage(OWNER_NUMBER, { text: ownerAlert });
        }
    });
}

// Web Arayüzü (QR Kod ve Durum Kontrolü)
app.get('/', (req, res) => {
    const pass = req.query.pass;
    if (pass !== ADMIN_PASSWORD) {
        return res.status(401).send('<h3>Yetkisiz Erişim. Lütfen URL sonuna ?pass=SIFRENIZ ekleyin.</h3>');
    }

    if (qrCodeData) {
        res.send(`
            <html>
                <body style="font-family:sans-serif;text-align:center;padding:40px;">
                    <h2>Furkan Bey WhatsApp Asistanı</h2>
                    <p>${connectionStatus}</p>
                    <img src="${qrCodeData}" style="width:280px;height:280px;border:1px solid #ccc;padding:10px;" />
                    <p>WhatsApp > Bağlı Cihazlar menüsünden okutun.</p>
                    <script>setTimeout(() => location.reload(), 15000);</script>
                </body>
            </html>
        `);
    } else {
        res.send(`
            <html>
                <body style="font-family:sans-serif;text-align:center;padding:40px;">
                    <h2>Furkan Bey WhatsApp Asistanı</h2>
                    <h3>Durum: ${connectionStatus}</h3>
                </body>
            </html>
        `);
    }
});

app.listen(PORT, () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor...`);
    connectToWhatsApp();
});
