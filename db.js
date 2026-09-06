require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sky_avenue_360';

mongoose.connect(MONGODB_URI)
  .then(async () => {
      console.log('Successfully connected to MongoDB');
      await cleanupLegacyIndexes();
      await migrateLegacyUsers();
      await seedAdmin();
  })
  .catch(err => {
      console.error('MongoDB connection error:', err);
  });

// --- SCHEMAS & MODELS ---

const userSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true, index: true },
    name: { type: String, default: '' },
    password_hash: { type: String, required: true },
    // Admin-only recoverable copy for client invite lookup / handoff
    access_password: { type: String, default: null },
    device_limit: { type: Number, default: 2 },
    expires_at: { type: Date, default: null },
    is_admin: { type: Boolean, default: false },
    created_at: { type: Date, default: Date.now }
});

userSchema.virtual('id').get(function() {
    return this._id.toHexString();
});
userSchema.set('toJSON', { virtuals: true });
userSchema.set('toObject', { virtuals: true });

const sessionSchema = new mongoose.Schema({
    session_id: { type: String, required: true, unique: true },
    user_id: { type: String, required: true },
    device_id: { type: String, required: true },
    ip_address: { type: String, default: 'unknown' },
    user_agent: { type: String, default: 'unknown' },
    last_active: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Session = mongoose.model('Session', sessionSchema);

function normalizePhone(phone) {
    if (typeof phone !== 'string') return null;

    const digits = phone.replace(/\D/g, '');
    if (!digits) return null;

    if (digits.length === 10) return digits;
    if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
    if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);

    return null;
}

function isValidPhone(phone) {
    const normalized = normalizePhone(phone);
    return normalized !== null && /^[6-9]\d{9}$/.test(normalized);
}

async function cleanupLegacyIndexes() {
    try {
        const indexes = await User.collection.indexes();
        const hasUsernameIndex = indexes.some(index => index.name === 'username_1');

        if (hasUsernameIndex) {
            try {
                await User.collection.dropIndex('username_1');
                console.log('Dropped legacy username_1 index');
            } catch (err) {
                if (err.code !== 27) {
                    throw err;
                }
            }
        }

        await User.updateMany({ username: { $exists: true } }, { $unset: { username: '' } });
    } catch (err) {
        console.error('Error cleaning legacy indexes:', err);
    }
}

async function migrateLegacyUsers() {
    try {
        const legacyUsers = await User.find({ username: { $exists: true } });
        const adminPhone = normalizePhone(process.env.ADMIN_PHONE || '');

        for (const user of legacyUsers) {
            if (user.username === 'admin' && adminPhone) {
                user.phone = adminPhone;
                user.set('username', undefined);
                await user.save();
                console.log(`Migrated legacy admin account to phone: ${adminPhone}`);
            }
        }
    } catch (err) {
        console.error('Error migrating legacy users:', err);
    }
}

async function seedAdmin() {
    try {
        await User.updateMany(
            { is_admin: true, $or: [{ name: { $exists: false } }, { name: '' }, { name: null }] },
            { $set: { name: 'Admin' } }
        );

        const phonesRaw = process.env.ADMIN_PHONES || process.env.ADMIN_PHONE || '';
        const adminPassword = process.env.ADMIN_INITIAL_PASSWORD || '';
        const phones = phonesRaw
            .split(',')
            .map((p) => normalizePhone(p.trim()))
            .filter(Boolean);

        if (phones.length === 0) {
            console.log('No ADMIN_PHONE / ADMIN_PHONES set — skipping admin seed.');
            return;
        }

        if (!adminPassword) {
            console.log('ADMIN_INITIAL_PASSWORD is not set — skipping admin seed.');
            return;
        }

        const passwordHash = bcrypt.hashSync(adminPassword, 10);
        const labels = ['Admin', 'Admin 2', 'Admin 3'];

        for (let i = 0; i < phones.length; i++) {
            const phone = phones[i];
            if (!isValidPhone(phone)) {
                console.warn(`Skipping invalid admin phone: ${phonesRaw.split(',')[i]}`);
                continue;
            }

            const existing = await User.findOne({ phone });
            if (existing) {
                existing.password_hash = passwordHash;
                existing.is_admin = true;
                existing.device_limit = 999;
                existing.expires_at = null;
                if (!existing.name) existing.name = labels[i] || `Admin ${i + 1}`;
                await existing.save();
                console.log(`Admin account updated (phone: ${phone}).`);
            } else {
                await User.create({
                    phone,
                    name: labels[i] || `Admin ${i + 1}`,
                    password_hash: passwordHash,
                    device_limit: 999,
                    expires_at: null,
                    is_admin: true
                });
                console.log(`Admin account created (phone: ${phone}).`);
            }
        }
    } catch (err) {
        console.error('Error seeding admin user:', err);
    }
}

// --- USER OPERATIONS ---

async function getUsers() {
    return await User.find({}, '-password_hash');
}

async function getUserById(id) {
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    return await User.findById(id);
}

async function getUserByPhone(phone) {
    const normalized = normalizePhone(phone);
    if (!normalized) return null;
    return await User.findOne({ phone: normalized });
}

async function createUser({ phone, password, name, durationDays, deviceLimit }) {
    const normalizedPhone = normalizePhone(phone);
    if (!isValidPhone(phone)) {
        throw new Error('Enter a valid 10-digit Indian mobile number');
    }

    const clientName = typeof name === 'string' ? name.trim() : '';
    if (!clientName) {
        throw new Error('Client name is required');
    }
    if (clientName.length > 80) {
        throw new Error('Client name is too long');
    }

    const existingUser = await getUserByPhone(normalizedPhone);
    if (existingUser) {
        throw new Error('This phone number is already registered');
    }

    const expiresAt = durationDays
        ? new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000)
        : null;

    const newUser = await User.create({
        phone: normalizedPhone,
        name: clientName,
        password_hash: bcrypt.hashSync(password, 10),
        access_password: password,
        device_limit: parseInt(deviceLimit, 10) || 2,
        expires_at: expiresAt,
        is_admin: false
    });

    const userJson = newUser.toJSON();
    delete userJson.password_hash;
    return userJson;
}

async function updateUserPassword(userId, password) {
    if (!mongoose.Types.ObjectId.isValid(userId)) {
        throw new Error('Invalid user id');
    }

    if (typeof password !== 'string' || !password.trim()) {
        throw new Error('Password is required');
    }

    if (password.length > 128) {
        throw new Error('Password is too long');
    }

    const user = await User.findById(userId);
    if (!user) {
        throw new Error('User not found');
    }

    if (user.is_admin) {
        throw new Error('Admin password cannot be changed from this panel');
    }

    user.password_hash = bcrypt.hashSync(password, 10);
    user.access_password = password;
    await user.save();

    // Force re-login on all devices after a password change
    await Session.deleteMany({ user_id: String(user._id) });

    const userJson = user.toJSON();
    delete userJson.password_hash;
    return userJson;
}

async function deleteUser(userId) {
    await User.findByIdAndDelete(userId);
    await Session.deleteMany({ user_id: userId });
}

// --- SESSION OPERATIONS ---

const SESSION_EXPIRY_MS = 60 * 60 * 1000;

async function cleanExpiredSessions() {
    const expiryThreshold = new Date(Date.now() - SESSION_EXPIRY_MS);
    await Session.deleteMany({ last_active: { $lt: expiryThreshold } });
}

async function getActiveSessions() {
    await cleanExpiredSessions();
    return await Session.find({});
}

async function getUserSessions(userId) {
    await cleanExpiredSessions();
    return await Session.find({ user_id: userId });
}

async function getSessionById(sessionId) {
    const session = await Session.findOne({ session_id: sessionId });
    if (!session) return null;

    const expiryThreshold = new Date(Date.now() - SESSION_EXPIRY_MS);
    if (session.last_active < expiryThreshold) {
        await Session.deleteOne({ session_id: sessionId });
        return null;
    }

    return session;
}

async function deleteUserDeviceSessions(userId, deviceId) {
    await Session.deleteMany({ user_id: userId, device_id: deviceId });
}

async function createSession({ userId, deviceId, ipAddress, userAgent }) {
    await cleanExpiredSessions();
    await deleteUserDeviceSessions(userId, deviceId);

    const newSession = await Session.create({
        session_id: crypto.randomUUID(),
        user_id: userId,
        device_id: deviceId,
        ip_address: ipAddress || 'unknown',
        user_agent: userAgent || 'unknown',
        last_active: new Date()
    });

    return newSession.toJSON();
}

async function updateSessionActive(sessionId) {
    const session = await Session.findOne({ session_id: sessionId });
    if (session) {
        session.last_active = new Date();
        await session.save();
        return true;
    }
    return false;
}

async function deleteSession(sessionId) {
    await Session.deleteOne({ session_id: sessionId });
}

module.exports = {
    getUsers,
    getUserById,
    getUserByPhone,
    createUser,
    updateUserPassword,
    deleteUser,
    getActiveSessions,
    getUserSessions,
    getSessionById,
    deleteUserDeviceSessions,
    createSession,
    updateSessionActive,
    deleteSession,
    cleanExpiredSessions,
    normalizePhone,
    isValidPhone
};
