# VisitSaudi — Windows Chrome ↔ server tunnel

Bu papkadagi skriptlar operator o'z Windows kompyuterida qo'lda VisitSaudi'ga
login qilgan Chrome sessiyasini, OCRumra serverdagi backend ulanishi uchun
**xavfsiz, shifrlangan teskari SSH tunnel** orqali ochadi.

**Nima bu EMAS**: bu skriptlar hech qachon VisitSaudi'ga avtomatik login
qilmaydi, parol/kuki saqlamaydi yoki CDP portini internetga ochiq qilmaydi.
Backend faqat allaqachon ochiq, operator login qilgan brauzerga **ulanadi**
— hech narsa o'zi ishga tushirmaydi.

## Oldindan kerak bo'ladigan narsalar (Windows)

1. **Google Chrome** o'rnatilgan bo'lishi kerak.
2. **OpenSSH klient** — Windows 10/11'da odatda allaqachon bor. Tekshirish:
   PowerShell'da `ssh -V` buyrug'ini yozing. Agar topilmasa:
   `Sozlamalar → Ilovalar → Ixtiyoriy funksiyalar → Funksiya qo'shish → OpenSSH Client`.
3. Serverga ulanish uchun **SSH kalit juftligi** (admin sizga beradi yoki
   o'zingiz yaratasiz — pastga qarang).

## Sozlash (bir martalik)

1. `visitsaudi-tunnel.config.example.json` faylini
   `visitsaudi-tunnel.config.json` nomiga nusxalang (shu papkada).
2. Yangi faylni oching va quyidagilarni to'ldiring:
   - `SshHost` — server manzili (admin beradi),
   - `SshUser` — SIZGA ATAB yaratilgan, cheklangan SSH foydalanuvchi nomi (admin beradi — **hech qachon** umumiy/root foydalanuvchi emas),
   - `SshKeyPath` — SSH maxfiy kalitingiz yo'li (masalan `C:\Users\SizningIsmingiz\.ssh\id_ed25519_visitsaudi`),
   - `RemotePort`/`LocalPort` — odatda ikkalasi ham `9222` (admin boshqacha port berishi mumkin).
3. **Bu `visitsaudi-tunnel.config.json` fayl hech qachon Git'ga commit
   qilinmaydi** — `.gitignore`'da allaqachon ro'yxatga olingan.

## Har kuni ishlatish

Eng oddiy yo'l — bitta skript ikkalasini ham ochadi:

```powershell
cd scripts\windows
.\Start-VisitSaudiSession.ps1
```

Bu ikkita alohida PowerShell oynasi ochadi:
- Bittasida — VisitSaudi uchun **alohida** Chrome oynasi (sizning kundalik
  Chrome profilingizdan butunlay ajratilgan).
- Ikkinchisida — teskari SSH tunnel (uzilsa, o'zi qayta ulanishga harakat
  qiladi).

So'ngra:
1. Yangi ochilgan Chrome oynasida VisitSaudi'ga **qo'lda** login qiling.
2. "Apply for eVisa" boshqaruv panelida (`APPLY FOR GROUP` tugmasi
   ko'rinadigan sahifada) qoldiring.
3. Shu bitta tabni ochiq qoldiring — boshqa, mos keladigan tab ochmang
   (bo'lmasa backend qaysi birini ishlatishni **taxmin qilmay**, xavfsiz
   to'xtaydi).
4. Telegram'da `/visa_start_submission` buyrug'ini yuboring.

Alohida ishlatish kerak bo'lsa:
```powershell
.\Start-VisitSaudiChrome.ps1      # faqat Chrome
.\Start-VisitSaudiTunnel.ps1      # faqat tunnel
```

## Server administratoriga kerak bo'ladigan sozlamalar

Bu skriptlar serverni o'zi sozlamaydi — quyidagilarni ANIQ server
administratoridan so'rang/tasdiqlang (men ularni bajarmadim):

1. **Cheklangan SSH foydalanuvchi** — faqat port-forward huquqiga ega,
   to'liq shell'siz. `authorized_keys` faylida operatorning public
   kalitiga qarshi: `no-pty,no-agent-forwarding,no-X11-forwarding,command="/bin/false" ssh-ed25519 AAAA...`
   (yoki OpenSSH'ning `PermitOpen`/`ForceCommand` mexanizmi orqali
   cheklash).
2. **`GatewayPorts no`** — sshd_config'da (odatda standart qiymat) —
   forward qilingan port serverning FAQAT o'z `127.0.0.1`ida ochilishini
   ta'minlaydi, tashqi tarmoqqa HECH QACHON chiqmaydi. Bu tasdiqlanishi
   kerak, o'zgartirilmasligi kerak (agar allaqachon shunday bo'lsa).
3. **`VISITSAUDI_CDP_ENDPOINT`** env o'zgaruvchisi OCRumra backend
   jarayoniga (`http://127.0.0.1:<RemotePort>`, masalan
   `http://127.0.0.1:9222`) — sukut bo'yicha O'CHIQ (o'rnatilmagan);
   admin buni FAQAT tayyor bo'lganda qo'shadi.
4. (Tavsiya) Tunnel uchun RemotePort faqat shu maxsus SSH foydalanuvchisi
   ochishi mumkin bo'lgan diapazonda cheklansin (`PermitOpen
   localhost:9222` kabi) — boshqa portlarni forward qilishga ruxsat
   bermaslik uchun.

## Agar tunnel yoki ulanish uzilib qolsa (davom ettirish)

Agar `/visa_start_submission` ishlab turganda tunnel uzilsa (uyqu rejimi,
tarmoq uzilishi) -- Chrome o'zi yopilmaydi, faqat ulanish uziladi:

1. `Start-VisitSaudiTunnel.ps1` oynasi o'zi qayta ulanishga harakat qiladi
   (hech narsa qilmang, kutib turing yoki qayta ishga tushiring).
2. Chrome oynasini **TEGMASDAN** qoldiring -- u allaqachon qaysi arizachi
   sahifasida bo'lsa, SHU holatda qolishi kerak (orqaga, boshqaruv
   paneliga QAYTISH SHART EMAS -- avvalgi urinishda qaysi arizachilar
   allaqachon SAVED bo'lgani serverning o'zi biladi va ularni qayta
   ishlamaydi).
3. Tunnel qayta ulangach, Telegram'da `/visa_start_submission`ni YANA
   yuboring -- backend avtomatik ravishda faqat navbatda qolgan
   (hali SAVED bo'lmagan) arizachilarni davom ettiradi, guruhni
   QAYTA YARATMAYDI.
4. **Tasdiqlanmagan holat**: agar uzilish AYNAN eng oxirgi (10-chi)
   arizachining SAVE tugmasini bosgandan keyin, lekin undan keyingi
   sahifa hali ko'rinmagan paytda sodir bo'lsa -- bu holat hali real
   portalda tekshirilmagan. Agar bot shu holatda "mos tab topilmadi"
   deb javob bersa, Chrome'dagi joriy sahifani qo'lda tekshiring va
   kerak bo'lsa real holatni menga xabar qiling.

## Nosozliklarni bartaraf etish

- **Bot "tunnel yoki Chrome ishlamayapti" deb javob bersa** — ikkala
  PowerShell oynasi ham ochiqligini, `ssh` oynasida xatolik yo'qligini
  tekshiring.
- **Bot "mos tab topilmadi" deb javob bersa** — Chrome'da "Apply for
  eVisa" (APPLY FOR GROUP tugmasi) sahifasi ochiqligini tekshiring;
  boshqa sahifaga o'tib ketgan bo'lishi mumkin.
- **Bot "bir nechta mos tab topildi" deb javob bersa** — ortiqcha
  tab(lar)ni yoping, faqat bitta qoldiring.
- **Tunnel tez-tez uziladi** — kompyuteringiz uyqu rejimiga o'tmasligini
  tekshiring (`powercfg` orqali sleep'ni vaqtincha o'chirish mumkin).

## Xavfsizlik eslatmalari

- Bu Chrome profili orqali ulangan har kim o'sha oynadagi **BARCHA**
  tablarni ko'radi/boshqaradi — shuning uchun FAQAT VisitSaudi uchun
  alohida profil ishlating, hech qachon kundalik Chrome'ingizni emas.
- Backend hech qachon cookie, parol yoki sessiya tokenini o'qimaydi yoki
  saqlamaydi — faqat sahifadagi ko'rinadigan matnni tekshiradi.
- `visitsaudi-tunnel.config.json` faylingizni hech kimga yubormang —
  u SSH kalit yo'lini o'z ichiga oladi (kalitning o'zini emas).
