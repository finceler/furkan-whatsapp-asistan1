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
const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');

const app = express();
const PORT = process.env.PORT || 3000;

// Çevre Değişkenleri ve Numara Ayarları
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const SHEET_WEBHOOK_URL = (process.env.SHEET_WEBHOOK_URL || '').trim();
const OWNER_NUMBER = '905XXXXXXXXX@s.whatsapp.net'; // KENDİ KİŞİSEL NUMARAN (Bildirimlerin gideceği numara)
const ASSISTANT_NUMBER = '905XXXXXXXXX'; // ASİSTAN BOTUNUN NUMARASI (Tıklanabilir link için, başında + olmadan)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'furkan123';

// Word Şablon Dosya Adları
const TARSUS_DOCX_TEMPLATE = 'Tarsus_Belediyesi_KEVSKK_Basvuru_Dilekcesi.docx';
const MERSIN_DOCX_TEMPLATE = 'Mersinbb_KEVSKK_Basvuru_Dilekcesi.docx';

let qrCodeData = null;
let connectionStatus = 'Bağlantı bekleniyor...';

const chatHistories = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function escapeXml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// Kullanıcının gönderdiği 7 maddelik formu doğrudan kod ile ayrıştıran fonksiyon
function parseKurulFormText(text) {
    const lines = text.split(/\r?\n/);
    const result = {
        mahallesi: '',
        adaNo: '',
        parselNo: '',
        muellifi: '',
        maliki: '',
        parselM2: '',
        insaatM2: ''
    };

    for (const line of lines) {
        const clean = line.trim();
        if (!clean) continue;

        const sepMatch = clean.match(/[:;]\s*(.+)$/);
        const val = sepMatch ? sepMatch[1].trim() : '';
        const lower = clean.toLocaleLowerCase('tr-TR');

        if (lower.includes('mahalle')) result.mahallesi = val;
        else if (lower.includes('ada')) result.adaNo = val;
        else if (lower.includes('parsel no') || (lower.includes('parsel') && !lower.includes('m²') && !lower.includes('m2'))) result.parselNo = val;
        else if (lower.includes('müellif')) result.muellifi = val;
        else if (lower.includes('malik')) result.maliki = val;
        else if (lower.includes('parsel') && (lower.includes('m²') || lower.includes('m2'))) result.parselM2 = val;
        else if (lower.includes('inşaat') || lower.includes('insaat')) result.insaatM2 = val;
    }

    if (result.mahallesi && result.adaNo && result.parselNo) {
        return result;
    }
    return null;
}

// Word (.docx) içindeki 1, 2, 3, 456 alanlarını dolduran fonksiyon
function fillDocxTemplate(templateFilename, data) {
    const filePath = path.join(__dirname, templateFilename);
    if (!fs.existsSync(filePath)) {
        console.error(`Şablon dosya bulunamadı: ${templateFilename}`);
        return null;
    }

    const content = fs.readFileSync(filePath, 'binary');
    const zip = new PizZip(content);
    let docXml = zip.file('word/document.xml').asText();

    const mahalle = escapeXml((data.mahallesi || '').toLocaleUpperCase('tr-TR').trim());
    const ada = escapeXml(String(data.adaNo || '').trim());
    const parsel = escapeXml(String(data.parselNo || '').trim());
    const malik = escapeXml((data.maliki || '').toLocaleUpperCase('tr-TR').trim());

    const textNodes = [];
    const regex = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let match;
    while ((match = regex.exec(docXml)) !== null) {
        textNodes.push({
            fullMatch: match[0],
            text: match[1],
            startIndex: match.index,
            endIndex: match.index + match[0].length
        });
    }

    let combinedText = '';
    const charMap = [];
    textNodes.forEach((node, nodeIdx) => {
        for (let i = 0; i < node.text.length; i++) {
            charMap.push({ nodeIdx, charIdx: i });
            combinedText += node.text[i];
        }
    });

    const patterns = [
        { regex: /(ilçesi,\s*)1(\s*Mahallesi)/gi, replacement: mahalle },
        { regex: /(tapunun\s*)2(\s*ada)/gi, replacement: ada },
        { regex: /(ada,\s*)3(\s*parsel)/gi, replacement: parsel },
        { regex: /(numarasında\s*)456(\s*adına)/gi, replacement: malik }
    ];

    const replacements = [];
    for (const p of patterns) {
        let m;
        while ((m = p.regex.exec(combinedText)) !== null) {
            const targetStart = m.index + m[1].length;
            const targetEnd = m[0].length - m[2].length + m.index;
            replacements.push({
                start: targetStart,
                end: targetEnd,
                value: p.replacement
            });
        }
    }

    replacements.sort((a, b) => b.start - a.start);

    const nodeChars = textNodes.map((n) => n.text.split(''));
    for (const rep of replacements) {
        if (rep.start >= charMap.length) continue;
        const firstPos = charMap[rep.start];
        nodeChars[firstPos.nodeIdx][firstPos.charIdx] = rep.value;
        for (let pos = rep.start + 1; pos < rep.end && pos < charMap.length; pos++) {
            const p = charMap[pos];
            nodeChars[p.nodeIdx][p.charIdx] = '';
        }
    }

    let rebuiltXml = '';
    let lastPos = 0;
    textNodes.forEach((node, idx) => {
        rebuiltXml += docXml.slice(lastPos, node.startIndex);
        const openTag = node.fullMatch.slice(0, node.fullMatch.indexOf('>') + 1);
        rebuiltXml += `${openTag}${nodeChars[idx].join('')}</w:t>`;
        lastPos = node.endIndex;
    });
    rebuiltXml += docXml.slice(lastPos);

    zip.file('word/document.xml', rebuiltXml);
    return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function sendKurulAttachments(sock, remoteJid) {
    try {
        const files = fs.readdirSync(__dirname);
        const attachments = files.filter((file) => {
            const lower = file.toLowerCase();
            return (
                (lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.pdf')) &&
                !lower.includes('package')
            );
        });

        for (const file of attachments) {
            const filePath = path.join(__dirname, file);
            const isExcel = file.toLowerCase().endsWith('.xlsx') || file.toLowerCase().endsWith('.xls');
            const mimetype = isExcel
                ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                : 'application/pdf';

            await sock.sendMessage(remoteJid, {
                document: fs.readFileSync(filePath),
                fileName: file,
                mimetype
            });
        }
    } catch (err) {
        console.error('Kurul ekleri gönderilirken hata:', err.message);
    }
}

async function getAvailableModels() {
    try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`);
        const data = await res.json();
        if (!data.models) return ['gemini-2.5-flash', 'gemini-3.8-flash'];

        const validModels = data.models
            .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
            .map((m) => m.name.replace('models/', ''))
            .filter((name) => name.includes('flash') || name.includes('pro'))
            .filter((name) => !name.includes('vision') && !name.includes('image') && !name.includes('tts'));

        validModels.sort((a, b) => {
            const score = (n) => (n.includes('flash') ? 10 : 0) + (n.includes('3.') ? 5 : n.includes('2.5') ? 3 : 0);
            return score(b) - score(a);
        });

        return validModels.length > 0 ? validModels : ['gemini-2.5-flash', 'gemini-3.8-flash'];
    } catch (e) {
        return ['gemini-2.5-flash', 'gemini-3.8-flash'];
    }
}

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

// Google E-Tablo'ya (KEVKS) yeni kayıt ekleme fonksiyonu
async function appendToKevksSheet(recordData) {
    if (!SHEET_WEBHOOK_URL) {
        console.error('HATA: Railway Variables içinde SHEET_WEBHOOK_URL tanımlı değil!');
        return { status: 'SHEET_WEBHOOK_URL_EKSIK' };
    }

    try {
        const response = await fetch(SHEET_WEBHOOK_URL, {
            method: 'POST',
            redirect: 'follow',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(recordData)
        });
        const rawText = await response.text();
        console.log('Google Apps Script Ham Yanıt:', rawText);
        try {
            return JSON.parse(rawText);
        } catch {
            return { status: 'yanit_ayristirilamadi', raw: rawText.slice(0, 120) };
        }
    } catch (error) {
        console.error('E-Tablo kayıt hatası:', error.message);
        return { status: 'error', message: error.message };
    }
}

function isOutOfOffice() {
    const now = new Date();
    const trTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Istanbul' }));
    const day = trTime.getDay();
    const totalMinutes = trTime.getHours() * 60 + trTime.getMinutes();

    if (day === 0 || day === 6) return true;
    if (totalMinutes < 8 * 60 + 30 || totalMinutes > 17 * 60 + 30) return true;
    return false;
}

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

Ayrıca Furkan Bey'in iş süreçleri hakkında şu kurallara uy:
1. TARSUS MAHALLE HAVA DURUMU:
   - Kullanıcı Tarsus veya mahalleleri (Bahşiş, Beydeğirmeni, Ünlüköy, Boztepe, Gülek, Çamlıyayla vb.) hakkında hava durumu sorarsa yardımcı ol.
2. RANDEVU VE ACİL DURUM YÖNETİMİ:
   - Kullanıcı "randevu" almak veya Furkan Bey ile görüşmek istediğini söylerse: Adını Soyadını ve görüşmek istediği konuyu sor.
   - Bilgiler tamamlandığında veya acil durum oluştuğunda yanıtının EN SONUNA şu etiketi ekle:
   [BILDIRIM: Kategori | Kısa Özet]
`;

    history.push({
        role: 'user',
        parts: [{ text: `Gönderen Adı: ${senderName} (${realPhone})\nMesaj: ${userMessage}` }]
    });

    if (history.length > 12) {
        history.splice(0, history.length - 12);
    }

    const modelsToTry = await getAvailableModels();
    let errorLogs = [];

    for (const modelName of modelsToTry.slice(0, 5)) {
        try {
            const replyText = await callGeminiModel(modelName, systemInstruction, history);
            history.push({
                role: 'model',
                parts: [{ text: replyText }]
            });
            return replyText;
        } catch (err) {
            errorLogs.push(`${modelName}: ${err.message}`);
            await sleep(800);
        }
    }

    history.pop();
    return `Şu an yapay zeka servisine bağlanılamadı. Detay: ${errorLogs[0] || 'Bilinmeyen hata'}`;
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

        const cleanLower = text.trim().toLocaleLowerCase('tr-TR');
        const senderName = msg.pushName || 'İsimsiz Kullanıcı';
        const realPhone = await resolveRealPhoneNumber(sock, msg);

        console.log(`Yeni mesaj [${senderName} - ${realPhone}]: ${text}`);

        // 1. KULLANICI 7 MADDELİK FORMU DOLDURUP GÖNDERDİYSE DOĞRUDAN YAKALA
        const parsedForm = parseKurulFormText(text);
        if (parsedForm) {
            await sock.sendPresenceUpdate('composing', remoteJid);

            const sheetResult = await appendToKevksSheet(parsedForm);

            const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
            const tarsusDocBuffer = fillDocxTemplate(TARSUS_DOCX_TEMPLATE, parsedForm);
            const mersinDocBuffer = fillDocxTemplate(MERSIN_DOCX_TEMPLATE, parsedForm);

            const confirmMsg =
                `✅ *KEVSKK Kurul Proje Kaydınız Alındı*\n\n` +
                `• *Mahallesi:* ${parsedForm.mahallesi.toLocaleUpperCase('tr-TR')}\n` +
                `• *Ada / Parsel:* ${parsedForm.adaNo} / ${parsedForm.parselNo}\n` +
                `• *Müellifi:* ${parsedForm.muellifi.toLocaleUpperCase('tr-TR')}\n` +
                `• *Maliki:* ${parsedForm.maliki.toLocaleUpperCase('tr-TR')}\n` +
                `• *Parsel / İnşaat m²:* ${parsedForm.parselM2} m² / ${parsedForm.insaatM2} m²\n\n` +
                `📄 Bilgilerinize göre otomatik doldurulan *Tarsus Belediyesi* ve *Mersin Büyükşehir Belediyesi* başvuru dilekçeleriniz ekte gönderilmektedir.`;

            await sock.sendMessage(remoteJid, { text: confirmMsg });

            if (tarsusDocBuffer) {
                await sock.sendMessage(remoteJid, {
                    document: tarsusDocBuffer,
                    fileName: `Tarsus_Belediyesi_KEVSKK_Basvuru_${parsedForm.adaNo}_${parsedForm.parselNo}.docx`,
                    mimetype: docxMime
                });
            }

            if (mersinDocBuffer) {
                await sock.sendMessage(remoteJid, {
                    document: mersinDocBuffer,
                    fileName: `MersinBB_KEVSKK_Basvuru_${parsedForm.adaNo}_${parsedForm.parselNo}.docx`,
                    mimetype: docxMime
                });
            }

            await sock.sendPresenceUpdate('paused', remoteJid);

            if (OWNER_NUMBER.includes('905')) {
                const ownerAlert =
                    `🔔 *Yeni KEVSKK Kurul Kaydı*\n\n` +
                    `👤 *Gönderen:* ${realPhone} (${senderName})\n` +
                    `📍 *Taşınmaz:* ${parsedForm.mahallesi.toLocaleUpperCase('tr-TR')} Mah. ${parsedForm.adaNo} Ada ${parsedForm.parselNo} Parsel\n` +
                    `🏗️ *Müellif / Malik:* ${parsedForm.muellifi} / ${parsedForm.maliki}\n` +
                    `📊 *E-Tablo Durumu:* ${sheetResult.status} ${sheetResult.row ? `(Satır: ${sheetResult.row}, Sıra: ${sheetResult.siraNo})` : ''}`;

                await sock.sendMessage(OWNER_NUMBER, { text: ownerAlert });
            }
            return;
        }

        // 2. "kurul talep oluştur" YAZILIRSA HAZIR ŞABLONU GÖNDER
        if (cleanLower === 'kurul talep oluştur' || cleanLower.includes('kurul talep oluştur')) {
            const templateMsg =
                `1. Mahalle;\n` +
                `2. Ada No;\n` +
                `3. Parsel No;\n` +
                `4. Müellifi;\n` +
                `5. Maliki;\n` +
                `6. Parsel m²;\n` +
                `7. İnşaat m²;`;

            await sock.sendMessage(remoteJid, { text: templateMsg });
            return;
        }

        // 3. "kurul" YAZILIRSA GÜNCEL KURUL TARİHLERİ + TIKLANABİLİR LİNK + 2 EKİ GÖNDER
        if (cleanLower === 'kurul') {
            const prefilledForm =
                `1. Mahalle; \n` +
                `2. Ada No; \n` +
                `3. Parsel No; \n` +
                `4. Müellifi; \n` +
                `5. Maliki; \n` +
                `6. Parsel m²; \n` +
                `7. İnşaat m²; `;

            const botRawPhone = (sock.user?.id || ASSISTANT_NUMBER).split(':')[0].split('@')[0].replace(/\D/g, '');
            const clickableLink = `https://wa.me/${botRawPhone}?text=${encodeURIComponent(prefilledForm)}`;

            const kurulInfoMsg =
                `Merhaba, ben Furkan Bey’in yapay zeka asistanıyım.\n\n` +
                `🏛️ *MBB KEVSKK (Kent Estetiği Kurulu) Bilgilendirme*\n\n` +
                `📅 *En Yakın Kurul Bilgisi (21. Kurul):*\n` +
                `- Son Teslim Tarihi (Tarsus Bld. İmar ve Şehircilik Müd.): 20.11.2026\n\n` +
                `📅 *Bir Sonraki Kurul Bilgisi (22. Kurul):*\n` +
                `- Son Teslim Tarihi (Tarsus Bld. İmar ve Şehircilik Müd.): 04.12.2026\n\n` +
                `✍️ *Dosya Bilgilerini İletmek ve Otomatik Dilekçe Oluşturmak İçin Tıklayın:*\n` +
                `👉 ${clickableLink}\n` +
                `_(Linke tıkladığınızda 7 maddelik form mesaj kutunuza otomatik dolacaktır, yanlarını doldurup göndermeniz yeterlidir.)_\n\n` +
                `⚠️ *Önemli Teslim Uyarısı:* Belirtilen son teslim tarihi, evrakların Tarsus Belediyesi İmar ve Şehircilik Müdürlüğü'ne teslim edilmesi gereken en son tarihtir. Projelerin oluşabilecek yoğunluğu göz önünde bulundurularak evrakların son teslim tarihinden birkaç gün önce getirilmesi gerekmektedir.\n\n` +
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
                `MBB KEVSKK Proje Kontrol ve Başvuru dosyasında Proje Kontrol sayfası mimar tarafından doldurulacaktır. Proje Başvuru kısmında ise Mimar Bilgileri ile Parsel ve Malik Bilgileri yine mimar tarafından doldurulacaktır.\n\n` +
                `📎 İlgili kurul takvimi ve başvuru/kontrol Excel dosyaları ekte gönderilmektedir.`;

            await sock.sendMessage(remoteJid, { text: kurulInfoMsg });
            await sendKurulAttachments(sock, remoteJid);
            return;
        }

        // 4. DİĞER TÜM MESAJLAR İÇİN GEMINI AI SOHBETİ
        await sock.sendPresenceUpdate('composing', remoteJid);

        let aiResponse = await askGemini(remoteJid, senderName, realPhone, text);

        const notificationMatch = aiResponse.match(/\[BILDIRIM:\s*(.*?)\]/i);
        let notificationDetail = null;

        if (notificationMatch) {
            notificationDetail = notificationMatch[1].trim();
            aiResponse = aiResponse.replace(/\[BILDIRIM:\s*.*?\]/gi, '').trim();
        }

        const isFirstMessage = (chatHistories.get(remoteJid)?.length || 0) <= 2;
        if (isOutOfOffice() && (isFirstMessage || notificationDetail)) {
            aiResponse += `\n\n_Not: Şu an mesai saatleri dışındayız. Acil bir durum varsa mesajınızda *ACİL* belirtmeniz yeterlidir._`;
        }

        await sock.sendMessage(remoteJid, { text: aiResponse });
        await sock.sendPresenceUpdate('paused', remoteJid);

        const isUrgent = cleanLower.includes('acil');
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
