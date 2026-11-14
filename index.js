const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
// Geriye dönük uyumluluk: eski Railway değişkeni GEMINI_API_KEY geçiş süresince desteklenir.
const GROQ_API_KEY = process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || '';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'furkan';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
// Varsayılan yol mevcut kurulumla aynı tutulur; Volume geçişi ayrıca ve kontrollü yapılır.
const BAILEYS_AUTH_DIR = process.env.BAILEYS_AUTH_DIR || path.join(__dirname, 'auth_info_baileys');
// Furkan Bey'in ana WhatsApp numarası (Sabit olarak 905309455371 tanımlı)
const FURKAN_PHONE = (process.env.FURKAN_PHONE || '905309455371').replace(/\D/g, '');
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY || '';

let latestQR = '';
let isConnected = false;
let botStarting = false;
let activeSocket = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
const processedMessageIds = new Map();
const MESSAGE_DEDUPE_TTL_MS = 6 * 60 * 60 * 1000;

const chatHistory = new Map();
const pendingQuotes = new Map();
// İlk mesaj tanışma kontrolü (Her kullanıcıya ilk mesajında yapay zeka asistanı olduğunu belirtir)
const greetedUsers = new Set();

const DEFAULT_LOCATION = {
  name: 'Tarsus, Mersin',
  lat: 36.921833,
  lon: 34.870917
};

const INTRO_TEXT = "Merhaba, ben Furkan Bey’in yapay zeka asistanıyım.";

// =========================================================================
// 2026 MBB KEVSK KURUL TAKVİMİ
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
// HAVA DURUMU MODÜLÜ (Open-Meteo)
// =========================================================================
function getWeatherIconAndText(code) {
  if (code === 0) return '☀️ Açık';
  if (code === 1 || code === 2) return '🌤️ Az Bulutlu';
  if (code === 3) return '☁️ Çok Bulutlu';
  if (code === 45 || code === 48) return '🌫️ Sisli';
  if (code >= 51 && code <= 57) return '🌦️ Çisenti';
  if (code >= 61 && code <= 67) return '🌧️ Yağmurlu';
  if (code >= 71 && code <= 77) return '❄️ Kar Yağışlı';
  if (code >= 80 && code <= 82) return '⛈️ Sağanak Yağış';
  if (code >= 85 && code <= 86) return '🌨️ Kar Sağanağı';
  if (code >= 95) return '⚡ Gök Gürültülü Fırtına';
  return '🌡️ Parçalı Bulutlu';
}

async function resolveLocationFromText(rawText) {
  const coordMatch = rawText.match(/(-?\d{1,2}\.\d+)\s*[,;\s]\s*(-?\d{1,3}\.\d+)/);
  if (coordMatch) {
    const lat = parseFloat(coordMatch[1]);
    const lon = parseFloat(coordMatch[2]);
    return { name: `Koordinat (${lat.toFixed(4)}, ${lon.toFixed(4)})`, lat, lon };
  }

  let cleaned = rawText
    .replace(/24\s*saatlik/gi, '')
    .replace(/detaylı|detayli|detay/gi, '')
    .replace(/hava\s*durumu|hava\s*nasıl\s*olacak|hava\s*nasil\s*olacak|havarumu/gi, '')
    .replace(/için|icin|bölgesi|bolgesi|yerin/gi, '')
    .trim();

  cleaned = cleaned.replace(/['’](un|ün|ın|in|nun|nün|nın|nin|da|de|ta|te|ya|ye|a|e)\b/gi, '').trim();

  if (!cleaned || cleaned.length < 2) {
    return DEFAULT_LOCATION;
  }

  const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cleaned)}&count=5&language=tr&format=json`;
  const geoRes = await fetch(geoUrl);
  const geoData = await geoRes.json();

  if (geoData.results && geoData.results.length > 0) {
    const trMatch = geoData.results.find(r => r.country_code === 'TR') || geoData.results[0];
    const displayName = [trMatch.name, trMatch.admin1].filter(Boolean).join(', ');
    return { name: displayName, lat: trMatch.latitude, lon: trMatch.longitude };
  }

  return null;
}

async function getWeatherReport(rawText) {
  const isDetailed = /detay/i.test(rawText);
  const loc = await resolveLocationFromText(rawText);

  if (!loc) {
    return `⚠️ Belirttiğiniz konum haritada bulunamadı. Lütfen ilçe/mahalle adını (Örn: *Çamlıyayla hava durumu*) veya koordinatı (Örn: *36.9218, 34.8709 hava durumu*) yazarak tekrar deneyin.`;
  }

  const weatherUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&hourly=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation_probability,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,pressure_msl` +
    `&forecast_days=2&timezone=Europe%2FIstanbul&cell_selection=nearest`;

  const res = await fetch(weatherUrl);
  const data = await res.json();

  if (!data.hourly || !data.hourly.time) {
    return '⚠️ Hava durumu verisi şu an alınamadı, lütfen biraz sonra tekrar deneyin.';
  }

  const nowParts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false
  }).format(new Date()).replace(' ', 'T');
  const currentHourPrefix = nowParts.slice(0, 13) + ':00';

  let startIndex = data.hourly.time.findIndex(t => t >= currentHourPrefix);
  if (startIndex === -1) startIndex = 0;

  const endIndex = Math.min(startIndex + 24, data.hourly.time.length);
  const step = isDetailed ? 1 : 3;

  let lines = [];
  for (let i = startIndex; i < endIndex; i += step) {
    const timeStr = data.hourly.time[i].slice(11, 16);
    const temp = Math.round(data.hourly.temperature_2m[i]);
    const feels = Math.round(data.hourly.apparent_temperature[i]);
    const pop = data.hourly.precipitation_probability[i] ?? 0;
    const rain = data.hourly.precipitation[i] ?? 0;
    const wind = Math.round(data.hourly.wind_speed_10m[i]);
    const cloud = data.hourly.cloud_cover[i] ?? 0;
    const humidity = data.hourly.relative_humidity_2m[i] ?? 0;
    const pressure = Math.round(data.hourly.pressure_msl[i] ?? 0);
    const desc = getWeatherIconAndText(data.hourly.weather_code[i]);

    if (isDetailed) {
      lines.push(
        `🕒 *${timeStr}* | ${desc}\n` +
        `   🌡️ ${temp}°C (His: ${feels}°C) | 🌧️ %${pop} (${rain} mm)\n` +
        `   💨 ${wind} km/sa | ☁️ Bulut: %${cloud} | 💧 Nem: %${humidity} | 🧭 ${pressure} hPa`
      );
    } else {
      lines.push(
        `🕒 *${timeStr}* → *${temp}°C* | 🌧️ %${pop} (${rain} mm) | ${desc}`
      );
    }
  }

  const header = isDetailed
    ? `📊 *24 Saatlik DETAYLI Hava Tahmini (Saatlik)*\n📍 *Konum:* ${loc.name} (${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)})\n\n`
    : `🌦️ *24 Saatlik Hava Tahmini (3 Saatlik Özet)*\n📍 *Konum:* ${loc.name}\n\n`;

  const footer = isDetailed
    ? `\n\n_Kaynak: Open-Meteo Yüksek Çözünürlüklü Noktasal Grid_`
    : `\n\n💡 _Saatlik rüzgar, bulutluluk, nem ve basınç verileri için *"${loc.name.split(',')[0]} detaylı hava durumu"* yazabilirsiniz._`;

  return header + lines.join('\n') + footer;
}

// =========================================================================
// BÖLGESEL FİRMA BULMA & FİYAT TEKLİFİ TOPLAMA MODÜLÜ
// =========================================================================
function normalizeTRMobile(rawPhone) {
  if (!rawPhone) return null;
  let digits = String(rawPhone).replace(/\D/g, '');
  if (digits.startsWith('90') && digits.length === 12) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length === 11) digits = digits.slice(1);
  if (/^5\d{9}$/.test(digits)) {
    return '90' + digits;
  }
  return null;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function searchBusinessesOnline(searchQuery) {
  const results = [];
  const seenPhones = new Set();

  if (GOOGLE_PLACES_API_KEY) {
    try {
      const textSearchUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(searchQuery)}&language=tr&key=${GOOGLE_PLACES_API_KEY}`;
      const tsRes = await fetch(textSearchUrl);
      const tsData = await tsRes.json();

      for (const place of (tsData.results || []).slice(0, 12)) {
        const detailUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=name,formatted_phone_number,international_phone_number&language=tr&key=${GOOGLE_PLACES_API_KEY}`;
        const dRes = await fetch(detailUrl);
        const dData = await dRes.json();
        const rawPhone = dData.result?.international_phone_number || dData.result?.formatted_phone_number;
        const phone = normalizeTRMobile(rawPhone);
        if (phone && !seenPhones.has(phone)) {
          seenPhones.add(phone);
          results.push({ name: place.name, phone });
        }
      }
    } catch (e) {
      console.error('Google Places arama hatası:', e);
    }
  }

  try {
    const words = searchQuery.trim().split(/\s+/);
    const cityCandidate = words[0] || 'Tarsus';
    const keywordCandidate = words.slice(1).join(' ') || searchQuery;

    const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityCandidate)}&count=3&language=tr&format=json`);
    const geoData = await geoRes.json();
    const trLoc = (geoData.results || []).find(r => r.country_code === 'TR');

    if (trLoc) {
      const radius = 15000;
      const safeKeyword = keywordCandidate.replace(/["\\]/g, '');
      const overpassQuery = `
        [out:json][timeout:15];
        (
          node["name"~"${safeKeyword}",i](around:${radius},${trLoc.latitude},${trLoc.longitude});
          way["name"~"${safeKeyword}",i](around:${radius},${trLoc.latitude},${trLoc.longitude});
        );
        out center tags 25;
      `;
      const ovRes = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        body: overpassQuery
      });
      const ovData = await ovRes.json();

      for (const el of (ovData.elements || [])) {
        const tags = el.tags || {};
        const rawPhone = tags.phone || tags['contact:phone'] || tags['contact:whatsapp'] || tags.mobile;
        const phone = normalizeTRMobile(rawPhone);
        if (phone && !seenPhones.has(phone)) {
          seenPhones.add(phone);
          results.push({ name: tags.name || 'İşletme', phone });
        }
      }
    }
  } catch (e) {
    console.error('Overpass arama hatası:', e);
  }

  return results;
}

async function generateNaturalQuoteMessage(firmName, userRequest) {
  try {
    const prompt = [
      {
        role: 'user',
        parts: [{
          text: `Sen Furkan İnceler adına bir işletmeye WhatsApp üzerinden fiyat soran gerçek bir müşterisin.
Firma Adı: ${firmName}
Fiyat Sorulacak Konu/Detay: ${userRequest}

Kurallar:
- Kesinlikle yapay zeka, bot veya asistan olduğundan bahsetme.
- Samimi, kibar ve doğal bir Türkçe ile tek paragraf (en fazla 3 cümle) yaz.
- Firmaya adıyla selam ver ve doğrudan fiyat teklifi/bilgi iste.`
        }]
      }
    ];
    return await askGemini(prompt, 'Sen doğal bir müşteri diliyle kısa fiyat teklifi mesajı yazan yardımcısın.');
  } catch {
    return `Merhaba ${firmName}, iyi çalışmalar dilerim. ${userRequest} konusunda güncel fiyat teklifinizi paylaşabilir misiniz? Teşekkürler.`;
  }
}

async function startQuoteCampaign(sock, adminJid, topicLabel, firms, userRequest) {
  const validFirms = [];
  for (const f of firms) {
    try {
      const [check] = await sock.onWhatsApp(`${f.phone}@s.whatsapp.net`);
      if (check?.exists) {
        validFirms.push({ name: f.name, phone: f.phone, jid: check.jid });
      }
    } catch {}
  }

  if (validFirms.length === 0) {
    await sock.sendMessage(adminJid, {
      text: `⚠️ *${topicLabel}* için WhatsApp'ta aktif bir cep numarası bulunamadı.\n\n` +
            `💡 Doğrudan numara listesiyle sormak için şu komutu kullanabilirsin:\n` +
            `*!teklifliste 0532XXXXXXX, 0542XXXXXXX | ${userRequest}*`
    });
    return;
  }

  const listPreview = validFirms.map((f, idx) => `${idx + 1}. ${f.name} (+${f.phone})`).join('\n');
  await sock.sendMessage(adminJid, {
    text: `🚀 *Fiyat Teklifi Taraması Başlatıldı*\n\n` +
          `📌 *Konu:* ${topicLabel}\n` +
          `🏢 *WhatsApp Aktif Firma (${validFirms.length} adet):*\n${listPreview}\n\n` +
          `⏳ Spam koruması için firmalara *45–90 saniye* aralıklarla doğal mesaj gönderilecek ve yanıtlar geldikçe sana iletilecek.`
  });

  (async () => {
    for (let i = 0; i < validFirms.length; i++) {
      const firm = validFirms[i];
      try {
        const msgText = await generateNaturalQuoteMessage(firm.name, userRequest);
        await sock.sendMessage(firm.jid, { text: msgText });

        const cleanNum = firm.jid.split('@')[0];
        pendingQuotes.set(cleanNum, {
          firmName: firm.name,
          topic: topicLabel,
          askedAt: Date.now()
        });
      } catch (err) {
        console.error(`Firmaya mesaj gönderilemedi (${firm.name}):`, err);
      }

      if (i < validFirms.length - 1) {
        const randomDelayMs = (45 + Math.floor(Math.random() * 45)) * 1000;
        await sleep(randomDelayMs);
      }
    }

    await sock.sendMessage(adminJid, {
      text: `✅ *${topicLabel}* için listedeki tüm firmalara (${validFirms.length} firma) teklif mesajları iletildi. Yanıt geldikçe sana bildireceğim.`
    });
  })();
}

// =========================================================================
// TETİKLEYİCİ ANAHTAR KELİMELER VE BİLGİ BANKASI
// =========================================================================
const KEVSK_KELIMELER = ['kurul', 'kurul tarihi', 'kent estetiği', 'kent estetigi', 'kevsk', 'kevskk'];
const HAVA_KELIMELER = ['hava durumu', 'hava nasıl olacak', 'hava nasil olacak', 'havarumu', '24 saatlik hava'];

// Doğrudan Furkan Bey ile konuşma / görüşme / mesajlaşma talebi kalıpları
const GORUSME_TALEBI_KALIP = /(furkan\s*bey\s*(ile|le)|kendisi\s*(ile|le)|kendisiyle|bizzat|direkt|doğrudan)\s*(konuşmak|konusmak|görüşmek|gorusmek|mesajlaşmak|mesajlasmak|iletişime\s*geçmek|ulas|ulaş)|^(konuşmak|görüşmek|mesajlaşmak)\s*istiyorum/i;

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
Sen Furkan İnceler'in yapay zeka asistanısın.
Şu an Furkan Bey müsait değil. Gelen mesajlara kibar, profesyonel, kısa ve net Türkçe ile yanıt ver.

Bilgi Bankan:
${BILGI_BANKASI}

Görevlerin:
1. Karşı taraf Kent Estetiği, kurul tarihi, evrak listesi veya dosyalama hakkında soru sorarsa Bilgi Bankasındaki kesin bilgileri paylaş.
2. Eğer karşı taraf doğrudan Furkan Bey ile konuşmak, görüşmek veya mesajlaşmak istediğini söylerse:
   - Mutlaka "Talebinizi Furkan Bey'e iletiyorum, kendisi en kısa sürede size dönüş yapacaktır." şeklinde yanıt ver ve varsa konusunu/notunu sor.
   - Cevabının sonuna [[BILDIRIM: Kişinin adı | Doğrudan Görüşme / Mesajlaşma Talebi | Karşı taraf Furkan Bey ile görüşmek/mesajlaşmak istiyor]] etiketini ekle.
3. Karşı tarafa şu an Furkan Bey'in müsait olmadığını, en kısa sürede dönüş yapacağını belirt ve varsa ada/parsel numarasını veya iletmek istedikleri notu sor.

ÖNEMLİ BİLDİRİM KURALI:
Eğer kullanıcı Furkan Bey ile konuşmak/görüşmek/mesajlaşmak istediyse, iletmek istediği somut bir not paylaştıysa, ada/parsel bilgisi verdiyse VEYA görüşme için gün/saat bilgisi verdiyse, cevabının EN SONUNA şu gizli etiketi ekle:
[[BILDIRIM: Kişinin adı (biliniyorsa) | Konu / Görüşme Talebi | İletilecek Kısa Özet]]
Sadece genel hava durumu veya genel evrak bilgisi sorularında bu etiketi EKLEME.
`;

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

let cachedGroqModel = null;
let cachedGroqModelAt = 0;

async function getGroqModel() {
  if (GROQ_MODEL) return GROQ_MODEL;
  if (cachedGroqModel && Date.now() - cachedGroqModelAt < 6 * 60 * 60 * 1000) return cachedGroqModel;
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY ortam değişkeni tanımlı değil.');

  const modelsRes = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` }
  });
  if (!modelsRes.ok) throw new Error(`Groq model listesi alınamadı: HTTP ${modelsRes.status}`);
  const modelsData = await modelsRes.json();
  const availableModels = (modelsData.data || [])
    .map(m => m.id)
    .filter(id => !id.includes('whisper') && !id.includes('guard'));
  cachedGroqModel = availableModels.find(id => id.includes('llama') || id.includes('qwen')) || availableModels[0];
  cachedGroqModelAt = Date.now();
  if (!cachedGroqModel) throw new Error('Groq hesabında kullanılabilir bir sohbet modeli bulunamadı. GROQ_MODEL değişkenini tanımlayın.');
  return cachedGroqModel;
}

async function askGemini(history, customSystemPrompt = null) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY ortam değişkeni tanımlı değil.');
  const selectedModel = await getGroqModel();
  const messages = [
    { role: 'system', content: customSystemPrompt || SYSTEM_INSTRUCTION },
    ...history.map(m => ({
      role: m.role === 'model' ? 'assistant' : 'user',
      content: m.parts?.[0]?.text || ''
    }))
  ];

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({ model: selectedModel, messages, temperature: 0.4 })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Groq API hatası (HTTP ${response.status}): ${JSON.stringify(data)}`);
  return data.choices?.[0]?.message?.content || 'Şu an yanıt oluşturulamadı, notunuzu ileteceğim.';
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).send('QR yönetim erişimi kapalı. Railway ortam değişkenlerine ADMIN_PASSWORD ekleyin.');
  }
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) {
    res.set('WWW-Authenticate', 'Basic realm="Furkan Asistan Yönetimi"');
    return res.status(401).send('Yönetici girişi gerekli.');
  }
  let decoded = '';
  try { decoded = Buffer.from(encoded, 'base64').toString('utf8'); } catch {}
  const separator = decoded.indexOf(':');
  const username = separator >= 0 ? decoded.slice(0, separator) : '';
  const password = separator >= 0 ? decoded.slice(separator + 1) : '';
  if (!safeEqual(username, ADMIN_USERNAME) || !safeEqual(password, ADMIN_PASSWORD)) {
    res.set('WWW-Authenticate', 'Basic realm="Furkan Asistan Yönetimi"');
    return res.status(401).send('Kullanıcı adı veya parola hatalı.');
  }
  next();
}

function isDuplicateMessage(msg) {
  const id = msg.key?.id;
  if (!id) return false;
  const now = Date.now();
  for (const [key, timestamp] of processedMessageIds) {
    if (now - timestamp > MESSAGE_DEDUPE_TTL_MS) processedMessageIds.delete(key);
  }
  if (processedMessageIds.has(id)) return true;
  processedMessageIds.set(id, now);
  while (processedMessageIds.size > 5000) processedMessageIds.delete(processedMessageIds.keys().next().value);
  return false;
}

let reconnectDelayMs = 2000;
function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(reconnectDelayMs, 60000);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 60000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startBot().catch(err => console.error('WhatsApp yeniden başlatma hatası:', err));
  }, delay);
  console.log(`WhatsApp bağlantısı ${Math.round(delay / 1000)} saniye sonra yeniden denenecek.`);
}

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', whatsapp: isConnected ? 'connected' : 'disconnected' });
});

app.get('/', requireAdmin, async (req, res) => {
  if (isConnected) return res.send('<h2>✅ Furkan Asistan WhatsApp bağlantısı aktif.</h2>');
  if (!latestQR) return res.send('<h2>⏳ QR kod oluşturuluyor. Birkaç saniye sonra yenileyin.</h2>');
  const qrImage = await QRCode.toDataURL(latestQR);
  res.send(`<div style="text-align:center;font-family:sans-serif;margin-top:50px;"><h2>WhatsApp Business → Bağlı Cihazlar → Cihaz Bağla</h2><img src="${qrImage}" style="width:300px;height:300px"/><p>Bağlandıktan sonra sayfayı yenileyin.</p></div>`);
});

async function startBot() {
  if (botStarting || (activeSocket && isConnected)) return;
  botStarting = true;
  try {
    fs.mkdirSync(BAILEYS_AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(BAILEYS_AUTH_DIR);
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['Furkan Asistan', 'Chrome', '1.0.0']
    });
    activeSocket = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) { latestQR = qr; isConnected = false; }
      if (connection === 'close') {
        isConnected = false;
        activeSocket = null;
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) scheduleReconnect();
        else { latestQR = ''; console.error('WhatsApp oturumu kapatıldı. Yeniden QR bağlantısı gerekebilir.'); }
      } else if (connection === 'open') {
        isConnected = true;
        latestQR = '';
        reconnectDelayMs = 2000;
        console.log('WhatsApp bağlantısı başarılı!');
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      const msg = (messages || [])[0];
      if (!msg?.message || isDuplicateMessage(msg)) return;
        const sender = msg.key?.remoteJid || '';
        if (!sender || sender.endsWith('@g.us') || sender === 'status@broadcast') return;
        const senderNumber = sender.split('@')[0];
        const isAdminMessage = Boolean(FURKAN_PHONE && senderNumber === FURKAN_PHONE);
        // Kendi hesabından kişilere gönderilen normal mesajları işlemeyiz; kendi numarana gelen komutlara izin veririz.
        if (msg.key.fromMe && !isAdminMessage) return;
        const senderName = msg.pushName || 'Bilinmeyen Kişi';
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!text) return;
        try {
      const lowerText = text.toLocaleLowerCase('tr-TR');

      // 0A. SADECE FURKAN BEY'DEN GELEN FİYAT TEKLİFİ KOMUTLARI
      if (FURKAN_PHONE && senderNumber === FURKAN_PHONE) {
        if (lowerText.startsWith('!teklifliste ')) {
          const parts = text.slice(13).split('|');
          if (parts.length < 2) {
            await sock.sendMessage(sender, {
              text: '⚠️ Kullanım: *!teklifliste 0532XXXXXXX, 0542XXXXXXX | Sorulacak teklif mesajı*'
            });
            return;
          }
          const rawNumbers = parts[0].split(/[,;\s]+/).map(n => normalizeTRMobile(n)).filter(Boolean);
          const userRequest = parts.slice(1).join('|').trim();
          const firms = rawNumbers.map((phone, idx) => ({ name: `Firma ${idx + 1}`, phone }));
          await startQuoteCampaign(sock, sender, 'Özel Numara Listesi', firms, userRequest);
          return;
        }

        if (lowerText.startsWith('!teklif ')) {
          const parts = text.slice(8).split('|');
          if (parts.length < 2) {
            await sock.sendMessage(sender, {
              text: '⚠️ Kullanım: *!teklif Tarsus cam balkon | Balkon ölçüm 250x250 cm, fiyat alabilir miyim?*'
            });
            return;
          }
          const searchQuery = parts[0].trim();
          const userRequest = parts.slice(1).join('|').trim();
          await sock.sendMessage(sender, { text: `🔍 *${searchQuery}* için bölgedeki firmalar taranıyor, lütfen bekleyin...` });
          const firms = await searchBusinessesOnline(searchQuery);
          await startQuoteCampaign(sock, sender, searchQuery, firms, userRequest);
          return;
        }
      }

      // 0B. TEKLİF SORULAN BİR FİRMADAN YANIT GELDİYSE
      if (pendingQuotes.has(senderNumber)) {
        const quoteInfo = pendingQuotes.get(senderNumber);
        if (FURKAN_PHONE) {
          const furkanJid = `${FURKAN_PHONE}@s.whatsapp.net`;
          const quoteAlert =
            `💰 *Fiyat Teklifi Yanıtı Geldi*\n\n` +
            `🏢 *Firma:* ${quoteInfo.firmName} (${senderName})\n` +
            `📞 *Telefon:* +${senderNumber}\n` +
            `📌 *Konu:* ${quoteInfo.topic}\n` +
            `💬 *Gelen Yanıt:* "${text}"`;
          await sock.sendMessage(furkanJid, { text: quoteAlert });
        }
        return;
      }

      // İlk mesaj kontrolü: Her yeni kişiyle ilk temasın başına "Merhaba, ben Furkan Bey’in yapay zeka asistanıyım." eklenir
      const isFirstMessage = !greetedUsers.has(sender);
      if (isFirstMessage) {
        greetedUsers.add(sender);
      }
      const prefixIntro = (bodyText) => {
        if (!isFirstMessage) return bodyText;
        const cleanBody = bodyText.replace(/^merhaba[,!\s]*/i, '');
        return `${INTRO_TEXT}\n\n${cleanBody}`;
      };

      // 1. Doğrudan Furkan Bey ile Konuşma / Görüşme / Mesajlaşma Talebi
      if (GORUSME_TALEBI_KALIP.test(text)) {
        const replyMsg = prefixIntro(
          `Talebinizi Furkan Bey'e iletiyorum. Kendisi şu an müsait değil, mesajınızı gördüğünde size en kısa sürede dönüş yapacaktır.\n\nİletmemi istediğiniz özel bir konu veya not varsa buraya yazabilirsiniz.`
        );
        await sock.sendMessage(sender, { text: replyMsg });

        if (FURKAN_PHONE && senderNumber !== FURKAN_PHONE) {
          const furkanJid = `${FURKAN_PHONE}@s.whatsapp.net`;
          const alertText =
            `🔔 *Görüşme / Mesajlaşma Talebi*\n\n` +
            `👤 *Kişi:* ${senderName} (+${senderNumber})\n` +
            `📌 *Durum:* Karşı taraf doğrudan sizinle konuşmak / görüşmek istediğini belirtti.\n` +
            `💬 *Mesaj:* "${text}"`;
          await sock.sendMessage(furkanJid, { text: alertText });
        }
        return;
      }

      // 2. Hava Durumu Kontrolü
      const isWeatherQuery = HAVA_KELIMELER.some(k => lowerText.includes(k));
      if (isWeatherQuery) {
        const weatherReport = await getWeatherReport(text);
        await sock.sendMessage(sender, { text: prefixIntro(weatherReport) });
        return;
      }

      // 3. KEVSKK / Kent Estetiği Kontrolü
      const isKevskQuery = KEVSK_KELIMELER.some(k => lowerText.includes(k));
      if (isKevskQuery) {
        const bilgiMesaji = getKevskBilgiMesaji();
        await sock.sendMessage(sender, { text: prefixIntro(bilgiMesaji) });
        await sendKevskDocuments(sock, sender);
        return;
      }

      // 4. Diğer tüm mesajlar için Yapay Zeka devreye girer
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

      const finalReply = prefixIntro(rawReply);

      history.push({ role: 'model', parts: [{ text: finalReply }] });
      chatHistory.set(sender, history);

      await sock.sendMessage(sender, { text: finalReply });

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
  } catch (err) {
    botStarting = false;
    activeSocket = null;
    console.error('WhatsApp başlatılamadı:', err);
    scheduleReconnect();
    return;
  } finally {
    botStarting = false;
  }
}

app.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda çalışıyor.`);
  console.log(`Baileys oturum dizini: ${BAILEYS_AUTH_DIR}`);
  if (!process.env.BAILEYS_AUTH_DIR) {
    console.warn('UYARI: Baileys oturumu mevcut varsayılan dizinde. Railway Volume geçişi henüz yapılmadı; bu değişiklik mevcut oturumu korumak için bilinçli olarak ertelendi.');
  }
  if (!ADMIN_PASSWORD) console.warn('UYARI: ADMIN_PASSWORD tanımlı değil; QR yönetim sayfası güvenlik nedeniyle kapalı.');
  startBot().catch(err => console.error('İlk WhatsApp başlatma hatası:', err));
});
