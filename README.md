# 🎓 VibeCoded Learning Platform

Platformă modernă de învățare cu gamification, sistem de puncte, chat în timp real și management de task-uri.

## 📋 Cuprins

- [Funcționalități](#-funcționalități)
- [Stack Tehnologic](#-stack-tehnologic)
- [Setup Local Development](#-setup-local-development)
- [Deployment pe Dokploy](#-deployment-pe-dokploy)
- [Variabile de Mediu](#-variabile-de-mediu)
- [Structura Proiectului](#-structura-proiectului)
- [Comenzi Utile](#-comenzi-utile)
- [Troubleshooting](#-troubleshooting)

## ✨ Funcționalități

### Pentru Studenți
- 🔐 Autentificare securizată cu email și cod 2FA
- 📊 Sistem de puncte (stars) și leaderboard
- 🎓 Cursuri (ex. „QA Automation Engineer”) cu înscriere — „All courses” / „My courses”
- 🛤️ Fiecare curs este un drum continuu: faze → lecții → task-uri, cu faze blocate până sunt atinse (configurabil per fază: faza anterioară terminată și/sau stele necesare)
- 🗺️ Hartă tip quest: ✕ pentru lecțiile terminate, 🚩 unde ești acum, ? pentru ce urmează; cuprins pliabil în stânga care sare la lecție
- 👥 Pagina „Users” cu rolurile admin/student (studenții văd clasamentul, adminii gestionează conturile)
- 📝 Task-uri cu deadline-uri; predare ca și comentariu (link la PR / ticket Jira), fișier sau ambele
- 🧠 Quiz-uri și flashcards sub fiecare lecție, pentru pregătire (corectate pe server, cel mai bun scor salvat; nu blochează drumul)
- 📎 Materiale atașate lecției (PDF, Word, PowerPoint, TXT, Markdown): PDF/TXT/MD se deschid direct în aplicație, orice fișier se poate descărca
- 🔔 Notificări în timp real și pe email (cont aprobat, task nou, submisie aprobată/respinsă, stele primite); fiecare notificare are un link direct (deep link) spre task / pagina potrivită
- 💬 Chat în timp real cu Socket.IO
- 🖼️ Upload de imagini și fișiere în task-uri și chat
- 👥 Vizualizare utilizatori online
- 🎯 Progres vizual și task-uri deblocate progresiv

### Pentru Administratori
- 👨‍💼 Panou complet de administrare
- ➕ Creare și editare cursuri și faze (ordine, blocare după faza anterioară, stele necesare)
- 📚 Management lecții și task-uri
- ✅ Aprobare/respingere submisii studenți; pagina „Submissions” listează tot ce au predat studenții, cu link direct la lecție/task
- 📜 Script de lecție (Markdown, doar pentru admin): pregătești planul lecției înainte și îl urmărești în timpul ei
- 🧠 Quiz-uri și flashcards per lecție: editor în aplicație (formular sau JSON) și API complet (`/api/study-sets`, vezi `docs/AGENT_API.md`)
- 📎 Atașare fișiere la lecție (drag & drop sau buton), redenumire, ștergere; și prin API (`/api/lessons/:id/files`)
- 🔄 Notificări live și pe email pentru utilizatori noi și submisii noi, cu link direct la submisie / utilizator
- 📊 Monitorizare progres studenți

## 🛠️ Stack Tehnologic

### Frontend
- ⚛️ **React 19** cu TypeScript
- ⚡ **Vite** - Build tool rapid
- 🎨 **Tailwind CSS** - Styling modern
- 🔌 **Socket.IO Client** - Real-time communication
- 📝 **TipTap** - Rich text editor

### Backend
- 🚀 **Node.js** + **Express**
- 🗄️ **PostgreSQL** - Database (forward-only SQL migrations in `server/db/migrations/`)
- 🔌 **Socket.IO** - WebSocket server
- 🔒 **JWT** + **HTTP-only cookies** - Authentication
- 📧 **Nodemailer** - Email notifications
- 🔐 **bcrypt** - Password hashing
- 📁 **Multer** - File uploads

## 💻 Setup Local Development

### Prerequisite

- **Node.js** v18+ ([Download](https://nodejs.org/))
- **PostgreSQL** 16+ (sau `docker compose up -d` pentru o instanță locală)
- **Git**

### Pași de Instalare

#### 1. Clonează Repository-ul

```bash
git clone https://github.com/azaporojan/learning-platform.git
cd learning-platform
```

#### 2. Setup Backend

```bash
cd server
npm install
```

Creează fișier `.env` (copiază din `.env.example`):

```bash
cp .env.example .env
```

Editează `server/.env` cu credențialele tale:

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=learning
DB_USER=learning
DB_PASSWORD=learning
JWT_SECRET=generate_with_openssl_rand_base64_48   # minim 32 caractere
BOOTSTRAP_ADMIN_EMAIL=you@example.com             # primul cont înregistrat cu acest email devine admin
EMAIL_USER=your_email@gmail.com                   # opțional local: fără email, cu LOG_LOGIN_CODES=true codurile de login apar în consolă
EMAIL_PASS=your_app_password
PORT=3001
NODE_ENV=development
FRONTEND_URL=http://localhost:5173
```

#### 3. Setup Database

Pornește un PostgreSQL local (user/parolă/db `learning`):

```bash
docker compose up -d
```

Nu există script de setup: serverul aplică singur migrațiile SQL din
`server/db/migrations/` la pornire (forward-only — pentru o schimbare de schemă adaugă un fișier
nou `NNN_nume.sql`, nu edita unul deja aplicat).

#### 4. Setup Frontend

```bash
cd ../client
npm install
```

Creează `client/.env` (opțional pentru local):

```env
VITE_API_URL=http://localhost:3001/api
VITE_SOCKET_URL=http://localhost:3001
```

În producție ambele rămân nesetate: clientul este servit de același server (`/api`, `/socket.io`).

#### 5. Pornește Aplicația

**Terminal 1 - Backend:**
```bash
cd server
npm run dev
```

**Terminal 2 - Frontend:**
```bash
cd client
npm run dev
```

Aplicația va fi disponibilă la: `http://localhost:5173`

#### 6. Creează Primul Admin

Setează `BOOTSTRAP_ADMIN_EMAIL` în `server/.env` și înregistrează-te cu acel email — contul este
creat direct ca admin aprobat. Alternativ, pentru un cont existent:

```bash
cd server && node scripts/promote_admin.js user@example.com
```

## 🚀 Deployment pe Dokploy

Aplicația rulează într-un **singur container** (Express servește API-ul sub `/api`, Socket.IO sub
`/socket.io` și build-ul React la `/`) pe Dokploy, cu o bază de date dedicată pe PostgreSQL-ul
partajat și un volum pentru upload-uri.

- Orice push pe `main` → CI (`.github/workflows/ci-cd.yml`) → imagine Docker în GHCR
  (`ghcr.io/azaporojan/learning-platform:latest` + `:<sha>`) → webhook Dokploy → redeploy.
- Rollback: redeploy al unui tag `:<sha>` anterior din Dokploy.
- Runbook complet (ID-uri Dokploy, secrete GitHub, checklist de prima instalare, troubleshooting):
  **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.
- Crearea bazei de date și a rolului aplicației: `scripts/sql/create-database.sql`.
- Creare de conținut prin API (agent AI / scripturi, cu API key): **[docs/AGENT_API.md](docs/AGENT_API.md)**.

Build local al imaginii:

```bash
docker build -t learning-platform .
docker run --rm -p 3001:3001 --env-file server/.env -e DB_HOST=host.docker.internal learning-platform
```

## 🔐 Variabile de Mediu

### Server (`server/.env`)

| Variabilă | Descriere | Exemplu |
|-----------|-----------|---------|
| `DB_HOST` | PostgreSQL host | `localhost` (Dokploy: `common-stuff-postgres-vmlpfq`) |
| `DB_PORT` | PostgreSQL port | `5432` |
| `DB_NAME` | Database name | `learning` |
| `DB_USER` | PostgreSQL role | `learning` |
| `DB_PASSWORD` | PostgreSQL password | — |
| `DB_SSL` | `true` dacă serverul cere TLS | nesetat |
| `JWT_SECRET` | Secret pentru cookie-ul de sesiune (**minim 32 caractere**, altfel serverul nu pornește în producție) | `openssl rand -base64 48` |
| `PASSWORD_PEPPER` | Cheia care criptează hash-urile parolelor (**obligatorie** peste tot în afară de `NODE_ENV=development`/`test`). Ține-o doar în Dokploy + manager de parole, niciodată în DB sau lângă backup-uri | `openssl rand -base64 32` |
| `PASSWORD_PEPPER_PREVIOUS` | Doar la rotirea cheii: cheia veche (hash-urile sunt re-criptate la pornire) | — |
| `BOOTSTRAP_ADMIN_EMAIL` | Primul cont înregistrat cu acest email devine admin aprobat | `you@example.com` |
| `EMAIL_USER` | Gmail pentru coduri de login + notificări | `your@gmail.com` |
| `EMAIL_PASS` | App password Gmail | `xxxx xxxx xxxx xxxx` |
| `PORT` | Port server | `3001` |
| `NODE_ENV` | Environment | `development` / `production` |
| `FRONTEND_URL` | URL public — baza linkurilor din emailuri (trebuie să fie adresa reală a aplicației în producție); origin CORS în dev | `http://localhost:5173` |
| `UPLOADS_DIR` | Director pentru fișierele încărcate | `server/uploads` (Docker: `/app/server/uploads`) |
| `MAX_UPLOAD_MB` / `MAX_IMAGE_UPLOAD_MB` | Limită dimensiune fișiere (submisii / imagini) | `25` / `10` |

### Client (`client/.env`)

| Variabilă | Descriere | Exemplu |
|-----------|-----------|---------|
| `VITE_API_URL` | Backend API URL (implicit `/api`, same-origin) | `http://localhost:3001/api` |
| `VITE_SOCKET_URL` | WebSocket URL (implicit: originul paginii) | `http://localhost:3001` |

## 📁 Structura Proiectului

```
learning-platform/
├── client/                 # Frontend React
│   ├── pages/             # Routes: Courses, Course road, Users
│   ├── components/        # React components
│   ├── contexts/          # React contexts (Socket)
│   ├── hooks/             # Custom hooks
│   ├── config.ts          # API configuration
│   ├── types.ts           # TypeScript types
│   ├── .env.example       # Environment template
│   └── package.json
├── server/                # Backend Node.js
│   ├── db/                # PostgreSQL pool + migrații SQL (forward-only)
│   ├── courses.js         # Rute pentru cursuri, înscrieri, directorul de utilizatori
│   ├── scripts/           # promote_admin.js
│   ├── uploads/           # User uploaded files
│   ├── index.js           # Main server file
│   ├── db.js              # Database connection
│   ├── .env.example       # Environment template
│   └── package.json
├── .gitignore
├── deploy.sh              # Linux/Mac deployment script
├── deploy.bat             # Windows deployment script
└── README.md
```

## 🔧 Comenzi Utile

### Development

```bash
# Server development cu auto-restart
cd server && npm run dev

# Client development
cd client && npm run dev

# Type checking (fără build)
cd client && npm run type-check
```

### Production

```bash
# Build client pentru producție
cd client && npm run build

# Start server în mod producție
cd server && npm start

# Preview build local
cd client && npm run preview
```

### Database

```bash
# PostgreSQL local
docker compose up -d

# Promovare admin
cd server && node scripts/promote_admin.js user@example.com

# Teste (unit + smoke test end-to-end pe o bază de date de test — schema `public` este recreată!)
cd server && DB_NAME=learning_test npm test

# Backup / restore
pg_dump -h localhost -U learning learning > backup_$(date +%Y%m%d).sql
psql -h localhost -U learning learning < backup_20260112.sql
```

### Docker / Producție

```bash
# Build local al imaginii de producție (client + server într-un container)
docker build -t learning-platform .

# Rulează imaginea (PostgreSQL-ul trebuie să fie accesibil la DB_HOST)
docker run --rm -p 3001:3001 --env-file server/.env -e DB_HOST=host.docker.internal learning-platform

# Health check
curl http://localhost:3001/api/health
```

Deploy-ul real este automat (push pe `main` → GHCR → Dokploy) — vezi [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## ⚠️ Troubleshooting

### Serverul nu pornește

**Eroare:** `Error: connect ECONNREFUSED`

**Soluție:**
- Verifică că PostgreSQL rulează: `docker compose ps` / `pg_isready -h localhost`
- Verifică credențialele în `.env` (`DB_*`) și că `JWT_SECRET` are minim 32 de caractere
- Verifică că baza de date există: `psql -h localhost -U learning -l`

### Port 3001 deja folosit

**Eroare:** `Error: listen EADDRINUSE: address already in use :::3001`

**Soluție:**
```bash
# Găsește procesul
lsof -i :3001  # Linux/Mac
netstat -ano | findstr :3001  # Windows

# Omoară procesul
kill -9 PID  # Linux/Mac
taskkill /PID PID /F  # Windows
```

### Email-urile nu se trimit

**În Development:** Normal - codurile 2FA apar în consolă

**În Production:**
1. Folosește Gmail App Password (nu parola ta normală)
2. Activează "Less secure app access" (Nu recomandat)
3. Configurează EMAIL_USER și EMAIL_PASS corect în `.env`

### Socket.IO nu se conectează

**Soluție:**
- Verifică că `VITE_SOCKET_URL` în client/.env este corect
- Verifică CORS în server: `allowedOrigins` trebuie să includă domeniul tău
- În production, verifică configurația Nginx pentru `/socket.io`

### Build client eșuează

**Eroare:** TypeScript errors

**Soluție:**
```bash
cd client
npm run type-check  # Vezi toate erorile
# Repară erorile, apoi:
npm run build
```

### Uploads nu funcționează în production

**Soluție:**
```bash
# Creează director uploads și dă permisiuni
sudo mkdir -p /var/www/learning-platform/server/uploads
sudo chown -R www-data:www-data /var/www/learning-platform/server/uploads
sudo chmod -R 755 /var/www/learning-platform/server/uploads
```

## 🔒 Securitate

### Important pentru Producție

1. **Schimbă JWT_SECRET:**
   ```bash
   openssl rand -base64 32
   ```

2. **Folosește HTTPS:** Instalează SSL cu Let's Encrypt

3. **Actualizează dependințele regulat:**
   ```bash
   npm audit
   npm audit fix
   ```

4. **Backup regulat:**
   - Database: zilnic
   - Uploads: săptămânal
   - Configurații: la fiecare modificare

5. **Firewall:**
   ```bash
   sudo ufw allow 80/tcp
   sudo ufw allow 443/tcp
   sudo ufw allow 22/tcp
   sudo ufw enable
   ```

## 📝 Note

- **Students vs Admins:** La crearea contului, toți sunt studenți. Pentru admin: `BOOTSTRAP_ADMIN_EMAIL` sau `node scripts/promote_admin.js user@example.com`
- **Task Approvals:** Doar adminii pot aproba/respinge task-uri
- **Real-time:** Socket.IO asigură update-uri instant pentru notificări, chat, și leaderboard
- **File Uploads:** Limită 10MB per fișier (configurabil în `server/index.js` - multer config)

## 🤝 Contribuții

Pentru bug-uri sau feature requests, deschide un issue pe GitHub.

## 📄 Licență

ISC

---

**Made with ❤️ for Antigravity Learning**
