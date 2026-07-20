# Sky Avenue — 360° Virtual Tour

Secure login + admin panel for the Sky Avenue interactive 360° tour.

## What’s in this repo

```
.
├── server.js          # Express app (auth, admin APIs, static tour)
├── db.js              # MongoDB models & helpers
├── views/             # login.html, admin.html
├── public/
│   ├── assets/        # Brand assets (logo, CSS)
│   └── tour/          # 3DVista tour (scripts, skin, lib…)
│       └── media/     # NOT in git — attach on EC2 (~3GB)
├── .env.example
└── package.json
```

`public/tour/media/` is gitignored on purpose (too large for GitHub).

## Local development

```bash
cp .env.example .env
# edit .env — MongoDB URI, admin phone/password

npm install
npm run dev
```

Open http://localhost:8080

## EC2 deployment plan

1. Clone this repo on EC2  
2. `npm install --production`  
3. Create `.env` on the server  
4. **Copy tour media** into `public/tour/media/` (rsync/scp)  
5. Start with `pm2` (or `npm start`)  
6. Put nginx + HTTPS in front

### Example media sync (from your Mac)

```bash
rsync -avz --progress \
  /path/to/local/360-website/public/tour/media/ \
  ubuntu@YOUR_EC2_IP:/var/www/sky-avenue-360/public/tour/media/
```

### Env on server

```env
PORT=8080
NODE_ENV=production
MONGODB_URI=mongodb+srv://...
ADMIN_PHONE=...
ADMIN_INITIAL_PASSWORD=...
COOKIE_SECURE=true
```

## Notes

- Login gates `/tour/`
- Admins go to `/admin`
- Clients go to `/tour/` after login
