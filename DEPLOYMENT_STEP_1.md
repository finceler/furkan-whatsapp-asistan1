# Furkan Asistan – İlk güvenli geçiş (v1.1.0)

Bu sürüm, mevcut WhatsApp oturum yolunu değiştirmeden güvenlik ve bağlantı kararlılığı iyileştirmeleri getirir.

## Bu sürümde yapılanlar

- Groq anahtar adı `GROQ_API_KEY` olarak tanımlandı. Geriye dönük uyumluluk için `GEMINI_API_KEY` geçici olarak destekleniyor.
- Groq model listesi her mesajda değil, en fazla 6 saatte bir sorgulanıyor. İstenirse `GROQ_MODEL` ile model sabitlenebilir.
- `/health` sağlık kontrolü eklendi.
- `/` QR/status sayfası HTTP Basic Auth ile korundu. `ADMIN_PASSWORD` tanımlı değilse sayfa kapalı kalır.
- Baileys yeniden bağlanma denemelerine artan bekleme süresi ve tekil yeniden başlatma kilidi eklendi.
- Mesaj kimlikleri süreç belleğinde 6 saat tutulup yinelenen mesajlar süzülüyor.
- Rüzgâr birimi `km/sa` olarak düzeltildi.
- Kullanılmayan `@google/genai` bağımlılığı kaldırıldı; gerçek API bağlantısı Groq olduğu için.
- `.gitignore` ve `.env.example` eklendi.

## Railway'e güvenli dağıtım sırası

1. GitHub deposunun mevcut çalışan sürümünü koruyun; mümkünse `pre-ai-hardening` gibi bir yedek branch/tag oluşturun.
2. Railway > Variables bölümünde `ADMIN_USERNAME` ve güçlü bir `ADMIN_PASSWORD` tanımlayın. Parolayı GitHub'a veya sohbet mesajına yazmayın.
3. `GROQ_API_KEY` ekleyin. Mevcut `GEMINI_API_KEY` değişkeni şimdilik kod tarafından okunmaya devam eder; anahtarı yeniden üretmeniz gerekmez.
4. Mevcut `FURKAN_PHONE` ve `GOOGLE_PLACES_API_KEY` değişkenlerini silmeyin.
5. Değişiklikleri deploy edin. `/health` adresinin HTTP 200 döndürdüğünü, `/` sayfasının parola istediğini ve WhatsApp bağlantısının açıldığını kontrol edin.
6. WhatsApp QR gerekiyorsa `/` adresini yönetici kullanıcı adı/parolasıyla açın.

## Önemli: Railway Volume geçişi bu sürümde otomatik yapılmıyor

Mevcut Baileys oturumunun deploy sırasında kaybolmaması için varsayılan `auth_info_baileys` yolu aynı bırakıldı. Railway Volume'u `/data` konumuna bağlamak ve `BAILEYS_AUTH_DIR=/data/auth_info_baileys` ayarlamak ayrı bir geçiş adımıdır. Önce mevcut oturum klasörünün yedeklenmesi ve yeni Volume'a güvenli aktarım planı yapılmalıdır. Bu değişkeni henüz ayarlamayın.

## Bu sürümün sınırları

- Konuşma geçmişi, karşılanmış kullanıcılar ve bekleyen teklifler hâlâ bellektedir; yeniden başlatmada kaybolabilir. PostgreSQL sonraki aşamadır.
- Mesaj yinelenme önleme bellektedir; süreç yeniden başlarsa geçmiş kimlikleri unutulur.
- Sesli mesaj, kalıcı hafıza, Google Takvim ve yönetim paneli henüz eklenmemiştir.
- Firma teklif kampanyası mevcut davranışını korur; otomatik dış mesaj gönderimi sonraki güvenlik aşamasında onay akışına alınmalıdır.
- Bu dosya canlı Railway ortamında test yapıldığı anlamına gelmez. Dağıtım sonrası gerçek WhatsApp testi gerekir.
