// ============================================================
// الخادم النهائي الكامل - جاك بوت
// يحتوي على كل شيء: الجوائز، البطاقات، الإحصائيات، الإدارة
// ============================================================

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
require('dotenv').config();

const app = express();
const server = createServer(app);

// ============================================================
// الثوابت - تأكد من أن ADMIN_ID صحيح
// ============================================================
const ADMIN_ID = '7011476249';
const PORT = process.env.PORT || 3000;

// ============================================================
// إعدادات Socket.IO
// ============================================================
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000,
    upgradeTimeout: 30000,
    allowEIO3: true,
    cookie: false
});

// ============================================================
// إعدادات Express
// ============================================================
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));

app.use(cors({
    origin: "*",
    credentials: true
}));

app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));

// حماية من الهجمات
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    message: 'Too many requests'
});
app.use('/api/', limiter);

// ============================================================
// اتصال قاعدة البيانات
// ============================================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 30,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

let dbConnected = false;

async function initDatabase(retries = 10, delay = 3000) {
    for (let i = 0; i < retries; i++) {
        try {
            await pool.query('SELECT 1');
            dbConnected = true;
            console.log('✅ Connected to PostgreSQL');
            await createTables();
            await insertDefaultData();
            return true;
        } catch (error) {
            console.log(`⚠️ DB attempt ${i + 1}/${retries} failed: ${error.message}`);
            if (i < retries - 1) {
                await new Promise(r => setTimeout(r, delay * (i + 1)));
            } else {
                console.error('❌ All DB attempts failed');
                dbConnected = false;
                setTimeout(() => initDatabase(5, 5000), 30000);
            }
        }
    }
}

// ============================================================
// إنشاء الجداول
// ============================================================
async function createTables() {
    try {
        // جدول إعدادات اللعبة
        await pool.query(`
            CREATE TABLE IF NOT EXISTS game_settings (
                id SERIAL PRIMARY KEY,
                setting_key VARCHAR(50) UNIQUE NOT NULL,
                setting_value JSONB,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // جدول الجوائز (4 جوائز فقط)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS game_prizes (
                id SERIAL PRIMARY KEY,
                prize_name VARCHAR(100) NOT NULL,
                prize_value INTEGER NOT NULL,
                prize_icon VARCHAR(50) NOT NULL,
                prize_symbol VARCHAR(10) NOT NULL,
                weight INTEGER DEFAULT 1,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // جدول صور البطاقات (4 صور)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS card_images (
                id SERIAL PRIMARY KEY,
                card_index INTEGER UNIQUE NOT NULL,
                image_url TEXT NOT NULL,
                symbol VARCHAR(10) NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // جدول سجل اللعب
        await pool.query(`
            CREATE TABLE IF NOT EXISTS game_plays (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(50) NOT NULL,
                prize_id INTEGER,
                prize_name VARCHAR(100),
                prize_value INTEGER,
                is_winner BOOLEAN DEFAULT false,
                cards_revealed INTEGER DEFAULT 0,
                matched_symbol VARCHAR(10),
                play_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                game_data JSONB,
                FOREIGN KEY (prize_id) REFERENCES game_prizes(id) ON DELETE SET NULL
            )
        `);

        // جدول إحصائيات المستخدمين
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_game_stats (
                user_id VARCHAR(50) PRIMARY KEY,
                total_plays INTEGER DEFAULT 0,
                total_wins INTEGER DEFAULT 0,
                total_losses INTEGER DEFAULT 0,
                total_prize_value INTEGER DEFAULT 0,
                last_play TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // جدول الإيداعات
        await pool.query(`
            CREATE TABLE IF NOT EXISTS game_deposits (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(50) NOT NULL,
                amount DECIMAL(20,2) NOT NULL,
                deposit_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_used BOOLEAN DEFAULT false
            )
        `);

        // جدول وقت آخر لعب (لمنع اللعب أكثر من مرة كل 24 ساعة)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_last_play (
                user_id VARCHAR(50) PRIMARY KEY,
                last_play_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                plays_today INTEGER DEFAULT 0
            )
        `);

        // جدول سجل التغييرات (لتتبع تعديلات المدير)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_logs (
                id SERIAL PRIMARY KEY,
                admin_id VARCHAR(50) NOT NULL,
                action VARCHAR(100) NOT NULL,
                details JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        console.log('✅ All tables created successfully');
    } catch (error) {
        console.error('❌ Error creating tables:', error.message);
        throw error;
    }
}

// ============================================================
// إدراج البيانات الافتراضية
// ============================================================
async function insertDefaultData() {
    try {
        // الجوائز الافتراضية (4 جوائز)
        const prizesCheck = await pool.query('SELECT COUNT(*) FROM game_prizes');
        if (parseInt(prizesCheck.rows[0].count) === 0) {
            await pool.query(`
                INSERT INTO game_prizes (prize_name, prize_value, prize_icon, prize_symbol, weight) VALUES
                ('🔥 الجائزة الكبرى', 10000, '🔥', '♠', 1),
                ('💎 جائزة ماسية', 5000, '💎', '♥', 2),
                ('⭐ جائزة ذهبية', 2500, '⭐', '♦', 3),
                ('🎯 جائزة فضية', 1000, '🎯', '♣', 4)
            `);
            console.log('✅ Default 4 prizes inserted');
        }

        // صور البطاقات الافتراضية
        const cardsCheck = await pool.query('SELECT COUNT(*) FROM card_images');
        if (parseInt(cardsCheck.rows[0].count) === 0) {
            const defaultImages = [
                { index: 0, url: 'https://i.imgur.com/spade.png', symbol: '♠' },
                { index: 1, url: 'https://i.imgur.com/heart.png', symbol: '♥' },
                { index: 2, url: 'https://i.imgur.com/diamond.png', symbol: '♦' },
                { index: 3, url: 'https://i.imgur.com/club.png', symbol: '♣' }
            ];
            for (const img of defaultImages) {
                await pool.query(
                    `INSERT INTO card_images (card_index, image_url, symbol) VALUES ($1, $2, $3)`,
                    [img.index, img.url, img.symbol]
                );
            }
            console.log('✅ Default card images inserted');
        }

        // الإعدادات الافتراضية
        const defaultSettings = [
            ['loading_image', JSON.stringify({ url: 'https://i.imgur.com/loading_bg.jpg' })],
            ['background_image', JSON.stringify({ url: 'https://i.imgur.com/game_bg.jpg' })],
            ['card_back_image', JSON.stringify({ url: 'https://i.imgur.com/card_back.jpg' })],
            ['deposit_required', JSON.stringify({ enabled: false, min_amount: 1000 })],
            ['max_attempts', JSON.stringify({ value: 5 })],
            ['cards_count', JSON.stringify({ value: 12 })],
            ['game_title', JSON.stringify({ text: '🎰 جاك بوت' })],
            ['cooldown_hours', JSON.stringify({ value: 24 })],
            ['lucky_prize', JSON.stringify({ name: '🍀 حظ أوفر', value: 100, icon: '🍀' })]
        ];

        for (const [key, value] of defaultSettings) {
            const check = await pool.query('SELECT COUNT(*) FROM game_settings WHERE setting_key = $1', [key]);
            if (parseInt(check.rows[0].count) === 0) {
                await pool.query(
                    `INSERT INTO game_settings (setting_key, setting_value) VALUES ($1, $2)`,
                    [key, value]
                );
            }
        }
        console.log('✅ Default settings inserted');

    } catch (error) {
        console.error('❌ Error inserting default data:', error.message);
    }
}

initDatabase();

// ============================================================
// Keep-Alive - منع النوم على Render
// ============================================================
setInterval(() => {
    console.log('💓 Keep-alive ping at:', new Date().toISOString());
}, 5 * 60 * 1000);

app.get('/ping', (req, res) => {
    res.status(200).json({
        status: 'alive',
        time: new Date().toISOString(),
        uptime: process.uptime(),
        db: dbConnected
    });
});

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        connections: io.engine?.clientsCount || 0,
        db: dbConnected,
        timestamp: new Date().toISOString()
    });
});

// ============================================================
// دوال قاعدة البيانات المساعدة
// ============================================================

async function query(text, params) {
    if (!dbConnected) {
        throw new Error('Database not connected');
    }
    try {
        const result = await pool.query(text, params);
        return result;
    } catch (error) {
        console.error('❌ Query error:', error.message);
        throw error;
    }
}

async function getSetting(key) {
    try {
        const result = await query('SELECT setting_value FROM game_settings WHERE setting_key = $1', [key]);
        return result.rows[0]?.setting_value || null;
    } catch (error) {
        return null;
    }
}

async function setSetting(key, value) {
    await query(
        `INSERT INTO game_settings (setting_key, setting_value) 
         VALUES ($1, $2) 
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2, updated_at = CURRENT_TIMESTAMP`,
        [key, value]
    );
}

async function getAllSettings() {
    const result = await query('SELECT setting_key, setting_value FROM game_settings');
    const settings = {};
    result.rows.forEach(row => {
        try {
            settings[row.setting_key] = row.setting_value;
        } catch (e) {
            settings[row.setting_key] = null;
        }
    });
    return settings;
}

async function getCardImages() {
    const result = await query('SELECT * FROM card_images ORDER BY card_index');
    return result.rows;
}

async function updateCardImage(index, imageUrl, symbol) {
    await query(
        `INSERT INTO card_images (card_index, image_url, symbol) 
         VALUES ($1, $2, $3) 
         ON CONFLICT (card_index) DO UPDATE SET image_url = $2, symbol = $3, updated_at = CURRENT_TIMESTAMP`,
        [index, imageUrl, symbol]
    );
}

async function logAdminAction(adminId, action, details) {
    await query(
        `INSERT INTO admin_logs (admin_id, action, details) VALUES ($1, $2, $3)`,
        [adminId, action, JSON.stringify(details)]
    );
}

// ============================================================
// دوال اللعبة الأساسية
// ============================================================

const gameState = {
    activeGames: new Map(),
    prizePool: [],
    cardImages: [],
    settings: {}
};

async function loadPrizes() {
    const result = await query('SELECT * FROM game_prizes WHERE is_active = true ORDER BY weight ASC');
    gameState.prizePool = result.rows;
    return gameState.prizePool;
}

async function loadCardImages() {
    gameState.cardImages = await getCardImages();
    return gameState.cardImages;
}

async function loadSettings() {
    gameState.settings = await getAllSettings();
    return gameState.settings;
}

function selectPrize() {
    const pool = gameState.prizePool;
    if (!pool || pool.length === 0) return null;
    const totalWeight = pool.reduce((sum, p) => sum + p.weight, 0);
    let random = Math.random() * totalWeight;
    for (const prize of pool) {
        random -= prize.weight;
        if (random <= 0) return prize;
    }
    return pool[0];
}

// ============================================================
// ✅ دالة التحقق من فترة الإنتظار - المدير مستثنى تماماً
// ============================================================
async function checkCooldown(userId) {
    // 🚫 المدير لا يخضع لفترة الإنتظار
    if (userId === ADMIN_ID) {
        console.log(`👑 Admin ${userId} exempt from cooldown`);
        return { allowed: true, remaining: 0 };
    }

    const cooldownSetting = await getSetting('cooldown_hours');
    const cooldownHours = cooldownSetting?.value || 24;

    const result = await query(
        `SELECT last_play_time FROM user_last_play WHERE user_id = $1`,
        [userId]
    );

    if (!result.rows[0]) {
        await query(
            `INSERT INTO user_last_play (user_id, last_play_time, plays_today) VALUES ($1, CURRENT_TIMESTAMP, 0)`,
            [userId]
        );
        return { allowed: true, remaining: 0 };
    }

    const lastPlay = new Date(result.rows[0].last_play_time);
    const now = new Date();
    const hoursDiff = (now - lastPlay) / (1000 * 60 * 60);

    if (hoursDiff >= cooldownHours) {
        await query(
            `UPDATE user_last_play SET last_play_time = CURRENT_TIMESTAMP, plays_today = 0 WHERE user_id = $1`,
            [userId]
        );
        return { allowed: true, remaining: 0 };
    }

    const remaining = cooldownHours - hoursDiff;
    return { allowed: false, remaining: remaining };
}

async function recordPlay(userId, prize, cardsRevealed, matchedSymbol, isWinner) {
    const result = await query(
        `INSERT INTO game_plays (user_id, prize_id, prize_name, prize_value, is_winner, cards_revealed, matched_symbol, game_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [userId, prize?.id || null, prize?.prize_name || 'حظ أوفر', prize?.prize_value || 100,
            isWinner, cardsRevealed, matchedSymbol || null, JSON.stringify({ cardsRevealed, matchedSymbol })]
    );

    await query(
        `INSERT INTO user_game_stats (user_id, total_plays, total_wins, total_losses, total_prize_value, last_play)
         VALUES ($1, 1, $2, $3, $4, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id) DO UPDATE SET
         total_plays = user_game_stats.total_plays + 1,
         total_wins = user_game_stats.total_wins + $2,
         total_losses = user_game_stats.total_losses + $3,
         total_prize_value = user_game_stats.total_prize_value + $4,
         last_play = CURRENT_TIMESTAMP`,
        [userId, isWinner ? 1 : 0, isWinner ? 0 : 1, isWinner ? (prize?.prize_value || 0) : 100]
    );

    // ✅ تحديث وقت آخر لعب للمستخدمين العاديين فقط
    if (userId !== ADMIN_ID) {
        await query(
            `INSERT INTO user_last_play (user_id, last_play_time, plays_today) 
             VALUES ($1, CURRENT_TIMESTAMP, 1)
             ON CONFLICT (user_id) DO UPDATE SET 
             last_play_time = CURRENT_TIMESTAMP, 
             plays_today = user_last_play.plays_today + 1`,
            [userId]
        );
    }

    return result.rows[0].id;
}

// ============================================================
// API Routes - الإدارة الكاملة
// ============================================================

// ----- الحصول على جميع الإعدادات -----
app.get('/api/settings', async (req, res) => {
    try {
        const settings = await getAllSettings();
        const cardImages = await getCardImages();
        const prizes = await loadPrizes();
        const luckyPrize = await getSetting('lucky_prize');

        res.json({
            success: true,
            settings,
            cardImages,
            prizes,
            luckyPrize
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ----- تحديث إعدادات متعددة دفعة واحدة -----
app.post('/api/admin/settings/batch', async (req, res) => {
    try {
        const { userId, settings } = req.body;
        if (userId !== ADMIN_ID) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }

        for (const [key, value] of Object.entries(settings)) {
            await setSetting(key, value);
        }

        await loadSettings();
        await logAdminAction(userId, 'batch_settings_update', settings);

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ----- تحديث إعداد واحد -----
app.post('/api/admin/settings', async (req, res) => {
    try {
        const { userId, key, value } = req.body;
        if (userId !== ADMIN_ID) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }

        await setSetting(key, value);
        await loadSettings();
        await logAdminAction(userId, 'setting_update', { key, value });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ----- الحصول على الجوائز -----
app.get('/api/prizes', async (req, res) => {
    try {
        const prizes = await loadPrizes();
        const luckyPrize = await getSetting('lucky_prize');
        res.json({ success: true, prizes, luckyPrize });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ----- إضافة أو تحديث جائزة -----
app.post('/api/admin/prizes', async (req, res) => {
    try {
        const { userId, prize } = req.body;
        if (userId !== ADMIN_ID) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }

        if (prize.id) {
            await query(
                `UPDATE game_prizes SET 
                    prize_name = $1, 
                    prize_value = $2, 
                    prize_icon = $3, 
                    prize_symbol = $4, 
                    weight = $5, 
                    is_active = $6,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $7`,
                [prize.prize_name, prize.prize_value, prize.prize_icon,
                    prize.prize_symbol, prize.weight, prize.is_active, prize.id
                ]
            );
        } else {
            await query(
                `INSERT INTO game_prizes (prize_name, prize_value, prize_icon, prize_symbol, weight, is_active)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [prize.prize_name, prize.prize_value, prize.prize_icon,
                    prize.prize_symbol, prize.weight, prize.is_active
                ]
            );
        }

        await loadPrizes();
        await logAdminAction(userId, 'prize_' + (prize.id ? 'update' : 'create'), prize);

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ----- حذف جائزة -----
app.delete('/api/admin/prizes/:id', async (req, res) => {
    try {
        const { userId } = req.body;
        if (userId !== ADMIN_ID) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }

        await query('DELETE FROM game_prizes WHERE id = $1', [req.params.id]);
        await loadPrizes();
        await logAdminAction(userId, 'prize_delete', { id: req.params.id });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ----- تحديث جائزة حظ أوفر -----
app.post('/api/admin/lucky-prize', async (req, res) => {
    try {
        const { userId, luckyPrize } = req.body;
        if (userId !== ADMIN_ID) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }

        await setSetting('lucky_prize', luckyPrize);
        await logAdminAction(userId, 'lucky_prize_update', luckyPrize);

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ----- تحديث صور البطاقات -----
app.post('/api/admin/card-images', async (req, res) => {
    try {
        const { userId, images } = req.body;
        if (userId !== ADMIN_ID) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }

        for (const img of images) {
            await updateCardImage(img.index, img.url, img.symbol);
        }

        await loadCardImages();
        await logAdminAction(userId, 'card_images_update', images);

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ✅ API بيانات المستخدم - مع إرجاع حالة المدير بوضوح
// ============================================================
app.get('/api/user/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const isAdmin = (userId === ADMIN_ID);

        console.log(`📡 User data requested: ${userId}, isAdmin: ${isAdmin}`);

        const stats = await query('SELECT * FROM user_game_stats WHERE user_id = $1', [userId]);
        const plays = await query(
            `SELECT * FROM game_plays WHERE user_id = $1 ORDER BY play_date DESC LIMIT 10`,
            [userId]
        );
        const cooldown = await checkCooldown(userId);

        console.log(`⏳ Cooldown for ${userId}: allowed=${cooldown.allowed}, remaining=${cooldown.remaining}`);

        res.json({
            success: true,
            user: {
                id: userId,
                isAdmin: isAdmin,
                stats: stats.rows[0] || { total_plays: 0, total_wins: 0, total_losses: 0, total_prize_value: 0 },
                plays: plays.rows,
                cooldown: cooldown
            }
        });
    } catch (error) {
        console.error('❌ User data error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// إحصائيات عامة (للمشرف)
// ============================================================
app.get('/api/admin/stats', async (req, res) => {
    try {
        const userId = req.query.userId;
        if (userId !== ADMIN_ID) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }

        const globalStats = await query(`
            SELECT 
                COUNT(*) as total_plays,
                SUM(CASE WHEN is_winner THEN 1 ELSE 0 END) as total_wins,
                SUM(CASE WHEN is_winner THEN 0 ELSE 1 END) as total_losses,
                COALESCE(SUM(prize_value), 0) as total_prizes,
                COUNT(DISTINCT user_id) as unique_players
            FROM game_plays
        `);

        const topPlayers = await query(`
            SELECT user_id, total_plays, total_wins, total_prize_value
            FROM user_game_stats 
            ORDER BY total_prize_value DESC 
            LIMIT 10
        `);

        const recentPlays = await query(`
            SELECT *, TO_CHAR(play_date, 'YYYY-MM-DD HH24:MI:SS') as formatted_date
            FROM game_plays 
            ORDER BY play_date DESC 
            LIMIT 20
        `);

        const allPrizes = await query('SELECT * FROM game_prizes ORDER BY weight ASC');
        const cardImages = await getCardImages();
        const luckyPrize = await getSetting('lucky_prize');
        const settings = await getAllSettings();

        const todayStats = await query(`
            SELECT COUNT(DISTINCT user_id) as active_today,
                   COUNT(*) as plays_today
            FROM game_plays 
            WHERE play_date >= CURRENT_DATE
        `);

        res.json({
            success: true,
            stats: {
                global: globalStats.rows[0],
                topPlayers: topPlayers.rows,
                recentPlays: recentPlays.rows,
                allPrizes: allPrizes.rows,
                cardImages,
                luckyPrize,
                settings,
                today: todayStats.rows[0] || { active_today: 0, plays_today: 0 }
            }
        });
    } catch (error) {
        console.error('❌ Admin stats error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ----- إضافة إيداع للمستخدم -----
app.post('/api/admin/deposit', async (req, res) => {
    try {
        const { userId, targetUserId, amount } = req.body;
        if (userId !== ADMIN_ID) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }

        if (!targetUserId || !amount || amount <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid data' });
        }

        await query(
            `INSERT INTO game_deposits (user_id, amount) VALUES ($1, $2)`,
            [targetUserId, amount]
        );

        await logAdminAction(userId, 'deposit_add', { targetUserId, amount });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ----- الحصول على سجل الإدارة -----
app.get('/api/admin/logs', async (req, res) => {
    try {
        const userId = req.query.userId;
        if (userId !== ADMIN_ID) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }

        const logs = await query(
            `SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT 50`
        );

        res.json({ success: true, logs: logs.rows });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// Socket.IO - إدارة اللعبة في الوقت الفعلي
// ============================================================

io.on('connection', (socket) => {
    console.log('🟢 New connection:', socket.id);
    let userId = null;
    let gameData = null;

    const pingInterval = setInterval(() => {
        if (socket.connected) {
            socket.emit('ping');
        }
    }, 30000);

    // ----- انضمام المستخدم وبدء اللعبة -----
    socket.on('join', async (data) => {
        try {
            userId = data.userId;
            socket.join(`user_${userId}`);

            console.log(`🎮 Player joined: ${userId}`);

            await loadPrizes();
            await loadCardImages();
            await loadSettings();

            // ✅ التحقق من مهلة 24 ساعة (المدير مستثنى)
            const cooldown = await checkCooldown(userId);
            console.log(`⏳ Cooldown for ${userId}: allowed=${cooldown.allowed}, remaining=${cooldown.remaining}`);

            if (!cooldown.allowed) {
                socket.emit('cooldown', {
                    remaining: cooldown.remaining,
                    message: `⏳ يمكنك اللعب مرة أخرى بعد ${Math.ceil(cooldown.remaining)} ساعة`
                });
                return;
            }

            if (gameState.activeGames.has(userId)) {
                socket.emit('error', {
                    code: 'GAME_ACTIVE',
                    message: '⚠️ لديك لعبة نشطة حالياً'
                });
                return;
            }

            // إنشاء لعبة جديدة
            const maxAttemptsSetting = await getSetting('max_attempts');
            const maxAttempts = maxAttemptsSetting?.value || 5;

            const cardsCountSetting = await getSetting('cards_count');
            const cardsCount = cardsCountSetting?.value || 12;

            const symbols = gameState.cardImages.map(c => c.symbol);

            // اختيار جائزة عشوائية
            const selectedPrize = selectPrize();
            if (!selectedPrize) {
                socket.emit('error', {
                    code: 'NO_PRIZES',
                    message: '❌ لا توجد جوائز متاحة'
                });
                return;
            }

            const winningSymbol = selectedPrize.prize_symbol;
            const cardSymbols = [];

            // 3 بطاقات متطابقة للفوز
            for (let i = 0; i < 3; i++) {
                cardSymbols.push(winningSymbol);
            }

            // ملء الباقي برموز عشوائية
            const otherSymbols = symbols.filter(s => s !== winningSymbol);
            while (cardSymbols.length < cardsCount) {
                const randomSymbol = otherSymbols[Math.floor(Math.random() * otherSymbols.length)];
                if (randomSymbol) cardSymbols.push(randomSymbol);
            }

            // خلط البطاقات بشكل عشوائي
            for (let i = cardSymbols.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [cardSymbols[i], cardSymbols[j]] = [cardSymbols[j], cardSymbols[i]];
            }

            gameData = {
                userId,
                cards: cardSymbols.map((symbol, index) => ({
                    id: index,
                    symbol: symbol,
                    isRevealed: false,
                    isMatched: false
                })),
                attempts: 0,
                maxAttempts: maxAttempts,
                isFinished: false,
                winningPrize: selectedPrize,
                winningSymbol: winningSymbol
            };

            gameState.activeGames.set(userId, gameData);

            // الحصول على صورة ظهر البطاقة من الإعدادات
            const cardBackSetting = await getSetting('card_back_image');
            const cardBackImage = cardBackSetting?.url || 'https://i.imgur.com/card_back.jpg';

            // إرسال بيانات اللعبة للعميل
            socket.emit('game_started', {
                cards: gameData.cards.map(c => ({
                    id: c.id,
                    isRevealed: false,
                    isMatched: false
                })),
                prize: selectedPrize,
                maxAttempts: gameData.maxAttempts,
                cardsCount: cardsCount,
                cardImages: gameState.cardImages,
                cardBackImage: cardBackImage,
                settings: gameState.settings
            });

            console.log(`🎮 Game started for: ${userId}`);

        } catch (error) {
            console.error('❌ Join error:', error);
            socket.emit('error', {
                code: 'SERVER_ERROR',
                message: '❌ حدث خطأ في الخادم'
            });
        }
    });

    // ----- كشف البطاقة -----
    socket.on('reveal_card', async (data) => {
        try {
            if (!userId || !gameState.activeGames.has(userId)) {
                socket.emit('error', {
                    code: 'NO_GAME',
                    message: '❌ لا توجد لعبة نشطة'
                });
                return;
            }

            const game = gameState.activeGames.get(userId);

            if (game.isFinished) {
                socket.emit('error', {
                    code: 'GAME_FINISHED',
                    message: '⚠️ انتهت اللعبة'
                });
                return;
            }

            if (game.attempts >= game.maxAttempts) {
                socket.emit('error', {
                    code: 'MAX_ATTEMPTS',
                    message: '⚠️ انتهت المحاولات'
                });
                return;
            }

            const card = game.cards[data.cardId];
            if (!card || card.isRevealed || card.isMatched) {
                socket.emit('error', {
                    code: 'INVALID_CARD',
                    message: '❌ بطاقة غير صالحة'
                });
                return;
            }

            // كشف البطاقة
            card.isRevealed = true;
            game.attempts++;

            const cardImage = gameState.cardImages.find(c => c.symbol === card.symbol);

            socket.emit('card_revealed', {
                cardId: data.cardId,
                symbol: card.symbol,
                imageUrl: cardImage?.image_url || '',
                attempts: game.attempts,
                remaining: game.maxAttempts - game.attempts
            });

            // التحقق من وجود 3 رموز متطابقة
            const revealedSymbols = game.cards
                .filter(c => c.isRevealed && !c.isMatched)
                .map(c => c.symbol);

            const symbolCounts = {};
            revealedSymbols.forEach(s => {
                symbolCounts[s] = (symbolCounts[s] || 0) + 1;
            });

            let matchedSymbol = null;
            for (const [symbol, count] of Object.entries(symbolCounts)) {
                if (count >= 3) {
                    matchedSymbol = symbol;
                    break;
                }
            }

            if (matchedSymbol) {
                // ✅ فوز - تطابق 3 رموز
                game.isFinished = true;
                const prize = gameState.prizePool.find(p => p.prize_symbol === matchedSymbol);
                const isWinner = prize !== null;

                await recordPlay(userId, prize, game.attempts, matchedSymbol, isWinner);

                // تجميع البطاقات المتطابقة
                const matchedCards = [];
                game.cards.forEach(c => {
                    if (c.symbol === matchedSymbol && c.isRevealed && !c.isMatched) {
                        c.isMatched = true;
                        const img = gameState.cardImages.find(ci => ci.symbol === c.symbol);
                        matchedCards.push({
                            id: c.id,
                            imageUrl: img?.image_url || ''
                        });
                    }
                });

                socket.emit('game_won', {
                    matchedSymbol,
                    prize: prize,
                    matchedCards: matchedCards,
                    isWinner: true,
                    attempts: game.attempts
                });

                // إشعار للجميع
                io.emit('win_notification', {
                    userId,
                    prizeName: prize?.prize_name || 'جائزة',
                    prizeValue: prize?.prize_value || 0,
                    symbol: matchedSymbol
                });

                gameState.activeGames.delete(userId);
                console.log(`🏆 Win for ${userId}: ${prize?.prize_name}`);

            } else if (game.attempts >= game.maxAttempts) {
                // 🍀 خسارة - حظ أوفر
                game.isFinished = true;

                const luckyPrizeSetting = await getSetting('lucky_prize');
                const luckyPrize = luckyPrizeSetting || {
                    name: '🍀 حظ أوفر',
                    value: 100,
                    icon: '🍀'
                };

                const luckyPrizeObj = {
                    prize_name: luckyPrize.name || 'حظ أوفر',
                    prize_value: luckyPrize.value || 100,
                    prize_icon: luckyPrize.icon || '🍀',
                    prize_symbol: '🍀'
                };

                await recordPlay(userId, luckyPrizeObj, game.attempts, null, false);

                const allCards = game.cards.map(c => ({
                    id: c.id,
                    symbol: c.symbol,
                    imageUrl: gameState.cardImages.find(ci => ci.symbol === c.symbol)?.image_url || ''
                }));

                socket.emit('game_lost', {
                    attempts: game.attempts,
                    allCards,
                    luckyPrize: luckyPrizeObj,
                    message: `🍀 حظ أوفر! حصلت على ${luckyPrizeObj.prize_value} SYP كجائزة ترضية`
                });

                gameState.activeGames.delete(userId);
                console.log(`🍀 Lucky prize for ${userId}: ${luckyPrizeObj.prize_value} SYP`);
            }

        } catch (error) {
            console.error('❌ Reveal error:', error);
            socket.emit('error', {
                code: 'SERVER_ERROR',
                message: '❌ حدث خطأ في معالجة البطاقة'
            });
        }
    });

    socket.on('disconnect', () => {
        clearInterval(pingInterval);
        console.log('🔴 Disconnected:', socket.id);
        if (userId && gameState.activeGames.has(userId)) {
            gameState.activeGames.delete(userId);
            console.log(`🧹 Cleaned game for user ${userId}`);
        }
    });
});

// ============================================================
// تشغيل الخادم
// ============================================================
server.listen(PORT, '0.0.0.0', () => {
    console.log('='.repeat(70));
    console.log('🚀 JACKPOT SERVER - FINAL COMPLETE VERSION');
    console.log('='.repeat(70));
    console.log(`📡 Server running on port ${PORT}`);
    console.log(`👑 Admin ID: ${ADMIN_ID}`);
    console.log(`🎯 4 Prizes + Lucky Prize system`);
    console.log(`🖼️ 4 Card Images (customizable)`);
    console.log(`⏰ 24-hour cooldown (Admin EXEMPTED)`);
    console.log(`💓 Keep-alive: every 5 minutes`);
    console.log(`📊 Full admin panel with stats`);
    console.log('='.repeat(70));
});

// معالجة إيقاف الخادم بشكل نظيف
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down gracefully...');
    server.close(() => {
        pool.end();
        console.log('✅ Server closed');
        process.exit(0);
    });
});

process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled rejection:', error);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught exception:', error);
});
