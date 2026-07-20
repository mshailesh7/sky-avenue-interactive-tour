require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 8080;
const isProduction = process.env.NODE_ENV === 'production';
const COOKIE_SECURE = isProduction || process.env.COOKIE_SECURE === 'true';

const SESSION_COOKIE_MAX_AGE = 60 * 60 * 1000;

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
        return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
}

function getCookieOptions(maxAge) {
    return {
        maxAge,
        httpOnly: true,
        sameSite: 'lax',
        secure: COOKIE_SECURE
    };
}

function isApiRequest(req) {
    return req.path.startsWith('/api/') || req.headers.accept?.includes('application/json');
}

function normalizeUserAgent(userAgent) {
    return typeof userAgent === 'string' ? userAgent : '';
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

// Custom Session Middleware (now async)
app.use(async (req, res, next) => {
    const sessionId = req.cookies.session_id;
    if (sessionId) {
        try {
            const currentSession = await db.getSessionById(sessionId);

            if (currentSession) {
                const user = await db.getUserById(currentSession.user_id);
                if (user) {
                    if (user.expires_at && new Date() > new Date(user.expires_at)) {
                        await db.deleteSession(sessionId);
                        res.clearCookie('session_id');
                        req.user = null;
                        req.session = null;
                    } else {
                        await db.updateSessionActive(sessionId);
                        req.user = user;
                        req.session = currentSession;
                    }
                } else {
                    await db.deleteSession(sessionId);
                    res.clearCookie('session_id');
                }
            } else {
                res.clearCookie('session_id');
            }
        } catch (err) {
            console.error('Session middleware error:', err);
        }
    }
    next();
});

function requireAuth(req, res, next) {
    if (!req.user) {
        if (isApiRequest(req)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        return res.redirect('/login');
    }
    next();
}

function requireAdmin(req, res, next) {
    if (!req.user || !req.user.is_admin) {
        if (isApiRequest(req)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        return res.redirect('/login');
    }
    next();
}

async function destroySession(req, res) {
    if (req.session) {
        try {
            await db.deleteSession(req.session.session_id);
        } catch (err) {
            console.error('Logout error:', err);
        }
    }
    res.clearCookie('session_id');
}

// Public brand assets (logo, styles)
const assetsDir = path.join(__dirname, 'public', 'assets');
app.use('/assets', express.static(assetsDir));
app.get('/favicon.ico', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'favicon.ico'));
});
app.get('/sky-avenue-logo.png', (req, res) => {
    res.sendFile(path.join(assetsDir, 'sky-avenue-logo.png'));
});

function postLoginRedirect(user) {
    if (user.is_admin) return '/admin';
    return '/welcome';
}

// Redirect root to welcome (clients) / admin / login
app.get('/', (req, res) => {
    if (!req.user) {
        return res.redirect('/login');
    }
    res.redirect(postLoginRedirect(req.user));
});

// Serve Login Page
app.get('/login', (req, res) => {
    if (req.user) {
        return res.redirect(postLoginRedirect(req.user));
    }
    res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

// Handle Login Submission (now async)
app.post('/login', async (req, res) => {
    const clientIp = getClientIp(req);

    const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    if (!phone || !password) {
        return res.status(400).json({ error: 'Please enter both phone number and password.' });
    }

    if (!db.isValidPhone(phone) || password.length > 128) {
        return res.status(400).json({ error: 'Invalid phone number or password.' });
    }

    try {
        const user = await db.getUserByPhone(phone);
        if (!user) {
            return res.status(401).json({ error: 'Invalid phone number or password.' });
        }

        const passwordMatch = bcrypt.compareSync(password, user.password_hash);
        if (!passwordMatch) {
            return res.status(401).json({ error: 'Invalid phone number or password.' });
        }

        if (user.expires_at && new Date() > new Date(user.expires_at)) {
            return res.status(403).json({ error: 'This account has expired. Please contact an administrator.' });
        }

        let deviceId = req.cookies.device_id;
        if (!deviceId) {
            deviceId = crypto.randomUUID();
            res.cookie('device_id', deviceId, getCookieOptions(10 * 365 * 24 * 60 * 60 * 1000));
        }

        const activeSessions = await db.getUserSessions(user.id);
        const activeDeviceIds = [...new Set(activeSessions.map(s => s.device_id))];

        if (activeDeviceIds.length >= user.device_limit && !activeDeviceIds.includes(deviceId)) {
            return res.status(400).json({
                error: `Device limit exceeded. You are already logged in on ${user.device_limit} device(s).`
            });
        }

        const session = await db.createSession({
            userId: user.id,
            deviceId,
            ipAddress: clientIp,
            userAgent: normalizeUserAgent(req.headers['user-agent'])
        });

        res.cookie('session_id', session.session_id, getCookieOptions(SESSION_COOKIE_MAX_AGE));

        res.json({ success: true, redirect: postLoginRedirect(user) });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

app.post('/logout', async (req, res) => {
    await destroySession(req, res);
    res.redirect('/login');
});

app.get('/logout', async (req, res) => {
    await destroySession(req, res);
    res.redirect('/login');
});

// Welcome gate (clients) — continue to tour or logout without editing tour files
app.get('/welcome', requireAuth, (req, res) => {
    if (req.user.is_admin) {
        return res.redirect('/admin');
    }
    res.sendFile(path.join(__dirname, 'views', 'welcome.html'));
});

app.get('/api/me', requireAuth, (req, res) => {
    res.json({
        id: req.user.id || req.user._id,
        name: req.user.name || (req.user.is_admin ? 'Admin' : 'Guest'),
        phone: req.user.phone,
        is_admin: Boolean(req.user.is_admin),
        device_limit: req.user.device_limit,
        expires_at: req.user.expires_at || null
    });
});

// Serve Admin Panel
app.get('/admin', requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

// --- ADMIN API ENDPOINTS (all now async) ---

app.get('/api/admin/data', requireAdmin, async (req, res) => {
    try {
        const users = await db.getUsers();
        const sessions = await db.getActiveSessions();

        const enrichedSessions = sessions.map(s => {
            const userObj = users.find(u => String(u.id) === String(s.user_id));
            const sessionObj = s.toObject ? s.toObject() : s;
            return {
                ...sessionObj,
                phone: userObj ? userObj.phone : 'Unknown',
                name: userObj?.name || (userObj?.is_admin ? 'Admin' : 'Client'),
                is_admin: Boolean(userObj?.is_admin),
                role: userObj?.is_admin ? 'Admin' : 'Client'
            };
        });

        res.json({ users, sessions: enrichedSessions });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/users', requireAdmin, async (req, res) => {
    const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const { durationDays, deviceLimit } = req.body;

    if (!name || !phone || !password) {
        return res.status(400).json({ error: 'Client name, phone number, and password are required.' });
    }

    if (name.length > 80) {
        return res.status(400).json({ error: 'Client name is too long.' });
    }

    if (!db.isValidPhone(phone)) {
        return res.status(400).json({ error: 'Enter a valid 10-digit Indian mobile number.' });
    }

    if (password.length > 128) {
        return res.status(400).json({ error: 'Password is too long.' });
    }

    try {
        const newUser = await db.createUser({
            phone,
            password,
            name,
            durationDays: durationDays ? parseInt(durationDays, 10) : null,
            deviceLimit: deviceLimit ? parseInt(deviceLimit, 10) : 2
        });
        res.json({ success: true, user: newUser });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(400).json({ error: 'This phone number is already registered.' });
        }
        res.status(400).json({ error: err.message });
    }
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
    try {
        await db.deleteUser(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/users/:id/password', requireAdmin, async (req, res) => {
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    if (!password.trim()) {
        return res.status(400).json({ error: 'Password is required.' });
    }

    if (password.length > 128) {
        return res.status(400).json({ error: 'Password is too long.' });
    }

    try {
        const user = await db.updateUserPassword(req.params.id, password);
        res.json({ success: true, user });
    } catch (err) {
        const status = err.message === 'User not found' ? 404 : 400;
        res.status(status).json({ error: err.message });
    }
});

app.post('/api/admin/sessions/revoke', requireAdmin, async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) {
        return res.status(400).json({ error: 'Session ID is required.' });
    }

    try {
        await db.deleteSession(sessionId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Gated 360-Tour files serving
app.use('/tour', requireAuth, express.static(path.join(__dirname, 'public', 'tour')));

app.use((req, res) => {
    res.status(404).send('Page not found');
});

app.listen(PORT, () => {
    console.log(`Server started on http://localhost:${PORT}`);
});
