# Panduan Deployment — Google Flow Admin Dashboard (Railway.app)

Sistem ini sengaja disederhanakan menjadi **2 file utama**:

- `server.js` — backend Express + Socket.io + Puppeteer-Extra (Stealth) + Queue + REST API
- `public/index.html` — frontend Admin Dashboard (CCTV live monitor, Bulk Generator, JSON Exporter)

Didukung oleh `Dockerfile` (Chromium + Node.js) agar bisa langsung di-deploy ke Railway.

---

## 1. Struktur Minimal untuk Deploy Mandiri

Jika Anda ingin men-deploy **hanya** modul Google Flow ini (terpisah dari template Next.js di
repo ini), cukup salin 4 berkas berikut ke repo/folder baru:

```
server.js
public/index.html
Dockerfile
package.json   (lihat daftar dependency di bawah)
```

Dependency minimum pada `package.json`:

```json
{
  "name": "google-flow-admin",
  "version": "1.0.0",
  "private": true,
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "dependencies": {
    "express": "^4",
    "socket.io": "^4",
    "puppeteer-extra": "^3",
    "puppeteer-extra-plugin-stealth": "^2",
    "puppeteer-core": "^22",
    "multer": "^1",
    "cors": "^2",
    "uuid": "^9",
    "archiver": "^6",
    "csv-parse": "^5",
    "dotenv": "^17"
  }
}
```

> Catatan: proyek ini memakai `puppeteer-core` (BUKAN `puppeteer`) supaya `npm install` tidak
> mengunduh Chromium ~300MB. Chromium disediakan oleh image Docker (`apt-get install chromium`).

---

## 2. Build & Deploy via Dockerfile di Railway

1. Push repo ke GitHub (minimal berisi `server.js`, `public/`, `Dockerfile`, `package.json`).
2. Di Railway: **New Project → Deploy from GitHub Repo**.
3. Railway otomatis mendeteksi `Dockerfile` dan membangun image (Chromium + Node 20 slim).
4. Set **Environment Variables** (Settings → Variables):

   | Variable | Default | Keterangan |
   |---|---|---|
   | `PORT` | `8080` | Railway biasanya inject otomatis |
   | `PUPPETEER_EXECUTABLE_PATH` | `/usr/bin/chromium` | Sudah di-set di Dockerfile |
   | `PUPPETEER_HEADLESS` | `true` | Set `false` hanya untuk debug lokal (butuh display) |
   | `CONCURRENCY` | `2` | Jumlah task generate paralel. **Jangan terlalu besar** di plan kecil Railway (RAM terbatas) agar tidak OOM |
   | `GENERATION_TIMEOUT_MS` | `240000` | Timeout per generation (ms) |
   | `DEFAULT_ACCOUNT_QUOTA` | `100` | Kuota default per akun baru |
   | `ADMIN_TOKEN` | *(kosong)* | Jika diisi, semua endpoint `/api/*` wajib header `x-admin-token` — **sangat disarankan diisi di production** |
   | `FLOW_URL` | `https://labs.google/fx/tools/flow` | URL Google Flow (sesuaikan bila Google memindahkan path) |
   | `SESSIONS_DIR` | `/app/sessions` | Lokasi penyimpanan cookie/session |

5. **Tambahkan Railway Volume** (penting agar sesi login tidak hilang saat redeploy):
   - Railway dashboard → service → **Volumes** → **New Volume**
   - Mount path: `/app/sessions`
   - Ukuran: 1–5 GB cukup untuk ratusan file cookie + metadata JSON.
6. Deploy. Setelah running, cek `https://<app>.up.railway.app/api/health`.
7. Buka dashboard di `https://<app>.up.railway.app/` — masukkan `ADMIN_TOKEN` di kolom pojok
   kanan atas bila diaktifkan.

---

## 3. Catatan Penting Seputar Memori (OOM) di Railway

- Setiap task generate menggunakan 1 Puppeteer **BrowserContext** (bukan browser penuh) dari
  1 instance Chromium bersama (`sharedBrowser`) — jauh lebih hemat RAM dibanding multi-browser.
- `CONCURRENCY` pada `TaskQueue` membatasi berapa context yang berjalan bersamaan. Untuk plan
  Railway dengan 512MB–1GB RAM, gunakan `CONCURRENCY=1` atau `2`. Untuk plan 2GB+ bisa `3–4`.
- Bulk Generate hingga 100 prompt akan **otomatis diantrekan**, bukan dijalankan sekaligus —
  progress bar di dashboard menampilkan status real-time dari task ke-1 s/d ke-100.

---

## 4. Selector DOM Google Flow (Perlu Pantauan Berkala)

Karena `labs.google/fx/tools/flow` adalah UI web yang bisa berubah sewaktu-waktu, selector
CSS untuk kotak prompt & tombol generate didefinisikan sebagai daftar fallback di `server.js`
(`SELECTORS.promptBox`, `SELECTORS.generateButton`) dan **bisa di-override tanpa ubah kode**
lewat environment variable:

```
FLOW_PROMPT_SELECTOR=textarea[data-testid="prompt-input"]
FLOW_GENERATE_BUTTON_SELECTOR=button[data-testid="generate-btn"]
```

Jika Google mengubah DOM dan generate mulai gagal, gunakan tab **CCTV Monitor** untuk melihat
tampilan live browser Puppeteer, inspeksi manual via remote-control (klik/ketik), lalu update
selector tersebut.

---

## 5. Keamanan

- Selalu set `ADMIN_TOKEN` di production — dashboard ini mengelola kredensial Google & cookie
  session, jangan biarkan terbuka publik tanpa autentikasi.
- File `./sessions/*.json` berisi cookie login — perlakukan sebagai rahasia (jangan commit ke
  git, sudah dikecualikan lewat `.dockerignore` & volume terpisah).
- Pertimbangkan menambahkan HTTPS/Reverse proxy (Railway menyediakan TLS otomatis di domain
  `*.up.railway.app`, atau pasang domain custom dengan proxy Cloudflare).

---

## 6. Development Lokal (tanpa Docker)

```bash
npm install
# install Chromium lokal, lalu:
export PUPPETEER_EXECUTABLE_PATH="/usr/bin/chromium-browser"   # sesuaikan OS Anda
export PUPPETEER_HEADLESS=false   # supaya bisa lihat browser saat debug
node server.js
# buka http://localhost:8080
```
