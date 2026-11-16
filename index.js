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
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const SHEET_WEBHOOK_URL = (process.env.SHEET_WEBHOOK_URL || '').trim();
const OWNER_NUMBER = '905XXXXXXXXX@s.whatsapp.net'; // KENDİ NUMARANI BURAYA YAZ (Başında + olmadan)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'furkan123';

// Yoğunluk durumunda sırayla denenecek aktif modeller
const FALLBACK_MODELS = [
    'gemini-2.5-flash',
    'gemini-3.8-flash',
    'gemini-2.5-flash-lite'
];

let qrCodeData = null;
let connectionStatus = 'Bağlantı bekleniyor...';

const chatHistories = new Map();

// Bekleme fonksiyonu
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// LID veya JID'den gerçek telefon numarasını çözen fonksiyon
async function resolveRealPhoneNumber(sock, msg) {
    const key = msg.key;
    let candidateJid = key.senderPn || key.remoteJidAlt || key.participant || key.remoteJid || '';

    if (candidateJid.endsWith('@lid') && sock?.signalRepository?.lidMapping?.getPNForLID) {
        try {
            const mappedPn = await sock.signalRepository.lidMapping.getPNForLID(candidateJid);
            if (mappedPn) {
                candidateJid = mappedPn;
            }
        } catch (err) {
            console.log('LID çözümleme atlandı:', err.message);
        }
    }

    const digits = candidateJid.split('@')[0].split(':')[0].replace(/\D/g, '');

    if (digits.startsWith('90') && digits.length === 12) {
        return `+${digits}`;
    }
    if (candidateJid.endsWith('@lid')) {
        return `Gizli Numara (LID: ${digits})`;
    }
    return digits ? `+${digits}` : 'Bilinmeyen Numara';
}

// Google E-Tablo'ya (KEVKS -> Sayfa3) yeni kayıt ekleme fonksiyonu
async function appendToKevksSheet(recordData) {
    if (!SHEET_WEBHOOK_URL) {
        console.warn('SHEET_WEBHOOK_URL tanımlı değil, e-tabloya yazılamadı.');
        return { status: 'skipped' };
    }

    try {
        const response = await fetch(SHEET_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(recordData)
        });
        const result = await response.json();
        console.log('E-Tablo kayıt sonucu:', result);
        return result;
    } catch (error) {
        console.error('E-Tablo kayıt hatası:', error.message);
        return { status: 'error', message: error.message };
    }
}

// Mesai saati kontrolü (Türkiye saati UTC+3, Hafta içi 08:30 - 17:30)
function isOutOfOffice() {
    const now = new Date();
    const trTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Istanbul' }));
    const day = trTime.getDay();
    const totalMinutes = trTime.getHours() * 60 + trTime.getMinutes();

    if (day === 0 || day === 6) return true;
    if (totalMinutes < 8 * 60 + 30 || totalMinutes > 17 * 60 + 30) return true;
    return false;
}

// Tek bir Gemini modeline istek atan fonksiyon
async function callGeminiModel(modelName, systemInstruction, history) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            system_instruction: { parts: [{ text: systemInstruction }] },
            contents: history,
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 1000
            }
        })
    });

    const data = await response.json();
    if (!response.ok || data.error) {
        throw new Error(data.error?.message || `HTTP ${response.status}`);
    }

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
        throw new Error('Boş yanıt döndü');
    }
    return text;
}

// Gemini AI Yanıt Üretici (Otomatik yedekli model zinciri ile)
async function askGemini(userId, senderName, realPhone, userMessage) {
    if (!GEMINI_API_KEY) {
        return 'Sistem yapılandırması eksik: Railway Variables içinde GEMINI_API_KEY tanımlı değil.';
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
   - Kullanıcı "kurul" veya KEVSKK süreçlerini sorduğunda:
     a) Mersin Büyükşehir Belediyesi (MBB) Kent Estetiği ve Sürdürülebilir Kent Kurulu (KEVSKK) proje başvuru sürecini ve 12 maddelik evrak kontrol listesini paylaş:
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
     b) HEMEN ARDINDAN kurul kayıt tablosuna işlenebilmesi için kullanıcıdan aşağıdaki 7 bilgiyi şablon halinde iste:
        *MAHALLESİ:*
        *ADA NO:*
        *PARSEL NO:*
        *MÜELLİFİ:*
        *MALİKİ:*
        *PARSEL m²:*
        *İNŞAAT m²:*

2. KURUL PROJE KAYIT ETİKETİ (ÇOK ÖNEMLİ):
   - Kullanıcı yukarıdaki 7 proje bilgisini (Mahalle, Ada No, Parsel No, Müellifi, Maliki, Parsel m², İnşaat m²) verdiğinde, bilgileri aldığını ve KEVKS kurul kayıt listesine eklendiğini nazikçe onayla.
   - Yanıtının EN SONUNA şu gizli JSON etiketini ekle (sistem bu veriyi doğrudan Google E-Tabloya kaydedecek):
   [KURUL_KAYIT: {"mahallesi":"...","adaNo":"...","parselNo":"...","muellifi":"...","maliki":"...","parselM2":"...","insaatM2":"..."}]
   - Bilgiler eksikse kullanıcıdan eksik alanları iste, 7 bilgi tamamlanmadan [KURUL_KAYIT: ...] etiketini EKLEME.

3. TARSUS MAHALLE HAVA DURUMU:
   - Kullanıcı Tarsus veya mahalleleri (Bahşiş, Beydeğirmeni, Ünlüköy, Boztepe, Gülek, Çamlıyayla vb.) hakkında hava durumu sorarsa yardımcı ol.

4. RANDEVU VE ACİL DURUM YÖNETİMİ:
   - Kullanıcı "randevu" almak veya Furkan Bey ile görüşmek istediğini söylerse: Adını Soyadını ve görüşmek istediği konuyu sor.
   - Bilgiler tamamlandığında veya acil durum/kurul kaydı oluştuğunda yanıtının EN SONUNA şu etiketi ekle:
   [BILDIRIM: Kategori | Kısa Özet]
`;

    history.push({
        role: 'user',
        parts: [{ text: `Gönderen Adı: ${senderName} (${realPhone})\nMesaj: ${userMessage}` }]
    });

    if (history.length > 12) {
        history.splice(0, history.length - 12);
    }

    let lastError = null;

    // Listedeki modelleri sırayla dene; biri yoğun ise diğerine geç
    for (const modelName of FALLBACK_MODELS) {
        try {
            const replyText = await callGeminiModel(modelName, systemInstruction, history);
            history.push({
                role: 'model',
                parts: [{ text: replyText }]
            });
            return replyText;
        } catch (err) {
            lastError = err;
            console.log(`[${modelName}] başarısız (${err.message}), sonraki modele geçiliyor...`);
            await sleep(1200);
        }
    }

    console.error('Tüm Gemini modelleri yoğun/hatalı:', lastError?.message);
    history.pop();
    return 'Şu an yapay zeka sunucularında anlık bir yoğunluk var, lütfen birkaç saniye sonra mesajınızı tekrar gönderin.';
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
        if (remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') return;

        const text =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            '';

        if (!text.trim()) return;

        const senderName = msg.pushName || 'İsimsiz Kullanıcı';
        const realPhone = await resolveRealPhoneNumber(sock, msg);

        console.log(`Yeni mesaj [${senderName} - ${realPhone}]: ${text}`);

        await sock.sendPresenceUpdate('composing', remoteJid);

        let aiResponse = await askGemini(remoteJid, senderName, realPhone, text);

        // 1. Kurul E-Tablo Kayıt Etiketini Yakala
        const kurulMatch = aiResponse.match(/\[KURUL_KAYIT:\s*(\{.*?\})\]/i);
        let kurulRecordSaved = null;

        if (kurulMatch) {
            try {
                const parsedData = JSON.parse(kurulMatch[1]);
                const sheetResult = await appendToKevksSheet(parsedData);
                kurulRecordSaved = { ...parsedData, sheetStatus: sheetResult.status, siraNo: sheetResult.siraNo };
            } catch (e) {
                console.error('KURUL_KAYIT JSON ayrıştırma hatası:', e.message);
            }
            aiResponse = aiResponse.replace(/\[KURUL_KAYIT:\s*\{.*?\}\]/gi, '').trim();
        }

        // 2. Genel Bildirim Etiketini Yakala
        const notificationMatch = aiResponse.match(/\[BILDIRIM:\s*(.*?)\]/i);
        let notificationDetail = null;

        if (notificationMatch) {
            notificationDetail = notificationMatch[1].trim();
            aiResponse = aiResponse.replace(/\[BILDIRIM:\s*.*?\]/gi, '').trim();
        }

        const isFirstMessage = (chatHistories.get(remoteJid)?.length || 0) <= 2;
        if (isOutOfOffice() && (isFirstMessage || notificationDetail || kurulRecordSaved)) {
            aiResponse += `\n\n_Not: Şu an mesai saatleri dışındayız. Acil bir durum varsa mesajınızda *ACİL* belirtmeniz yeterlidir._`;
        }

        await sock.sendMessage(remoteJid, { text: aiResponse });
        await sock.sendPresenceUpdate('paused', remoteJid);

        // 3. Sana Bildirim Gönder (Randevu, Acil veya Yeni Kurul Kaydı)
        const isUrgent = text.toLocaleLowerCase('tr-TR').includes('acil');
        if ((notificationDetail || isUrgent || kurulRecordSaved) && OWNER_NUMBER.includes('905')) {
            let detailText = notificationDetail || 'Acil Mesaj Bildirimi';
            if (kurulRecordSaved) {
                detailText = `Yeni KEVKS Kurul Kaydı (${kurulRecordSaved.mahallesi} Mah. Ada:${kurulRecordSaved.adaNo} Parsel:${kurulRecordSaved.parselNo}) - Tablo Durumu: ${kurulRecordSaved.sheetStatus}`;
            }

            const ownerAlert =
                `🔔 *Yeni Asistan Bildirimi*\n\n` +
                `👤 *Gönderen:* ${realPhone} (${senderName})\n` +
                `📋 *Detay:* ${detailText}\n` +
                `💬 *Son Mesaj:* "${text}"`;

            await sock.sendMessage(OWNER_NUMBER, { text: ownerAlert });
        }
    });
}

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
