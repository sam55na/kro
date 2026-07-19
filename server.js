// ============================================================
// الخادم الكامل للعبة جاك بوت مع نظام إدارة متكامل
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
const fs = require('fs');
require('dotenv').config();

const app = express();
const server = createServer(app);

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
app.use(express.static('public'));

// حماية من الهجمات
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: 'Too many requests'
});
app.use('/api/', limiter);

// ============================================================
// اتصال قاعدة البيانات
// ============================================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

async function initDatabase(retries = 5, delay = 5000) {
    for (let i = 0; i < retries; i++) {
        try {
            await pool.query('SELECT 1');
            console.log('✅ Connected to PostgreSQL');
            await createTables();
            await insertDefaultData();
            return true;
        } catch (error) {
            console.log(`⚠️ DB attempt ${i + 1}/${retries} failed: ${error.message}`);
            if (i < retries - 1) {
                await new Promise(r => setTimeout(r, delay));
            } else {
                console.error('❌ All DB attempts failed');
                process.exit(1);
            }
        }
    }
}

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

        // جدول الجوائز
        await pool.query(`
            CREATE TABLE IF NOT EXISTS game_prizes (
                id SERIAL PRIMARY KEY,
                prize_name VARCHAR(100) NOT NULL,
                prize_value INTEGER NOT NULL,
                prize_icon VARCHAR(50) NOT NULL,
                prize_symbol VARCHAR(10) NOT NULL,
                weight INTEGER DEFAULT 1,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

        console.log('✅ Tables created successfully');
    } catch (error) {
        console.error('❌ Error creating tables:', error.message);
    }
}

async function insertDefaultData() {
    try {
        // الجوائز الافتراضية
        const prizesCheck = await pool.query('SELECT COUNT(*) FROM game_prizes');
        if (parseInt(prizesCheck.rows[0].count) === 0) {
            await pool.query(`
                INSERT INTO game_prizes (prize_name, prize_value, prize_icon, prize_symbol, weight) VALUES
                ('🔥 جائزة كبرى', 10000, '🔥', '🔥', 1),
                ('💎 جائزة ماسية', 5000, '💎', '💎', 2),
                ('⭐ جائزة ذهبية', 2500, '⭐', '⭐', 3),
                ('🎯 جائزة فضية', 1000, '🎯', '🎯', 4),
                ('🎁 جائزة برونزية', 500, '🎁', '🎁', 5),
                ('🍀 حظ أوفر', 100, '🍀', '🍀', 10)
            `);
            console.log('✅ Default prizes inserted');
        }

        // الإعدادات الافتراضية
        const defaultSettings = [
            ['loading_image', JSON.stringify({ url: 'https://i.imgur.com/4t8nYJr.png' })],
            ['card_back_image', JSON.stringify({ url: 'https://i.imgur.com/cardback.jpg' })],
            ['card_front_images', JSON.stringify({})],
            ['deposit_required', JSON.stringify({ enabled: false, min_amount: 1000 })],
            ['game_animation', JSON.stringify({ enabled: true, duration: 3000 })],
            ['sound_effects', JSON.stringify({ enabled: true, volume: 70 })],
            ['max_attempts', JSON.stringify({ value: 5 })],
            ['cards_count', JSON.stringify({ value: 12 })],
            ['game_title', JSON.stringify({ text: '🎰 جاك بوت' })],
            ['theme_color', JSON.stringify({ primary: '#00ffff', secondary: '#a855f7' })]
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
// دوال Keep-Alive
// ============================================================

setInterval(() => {
    console.log('💓 Keep-alive ping at:', new Date().toISOString());
}, 5 * 60 * 1000);

app.get('/ping', (req, res) => {
    res.status(200).json({ status: 'alive', time: new Date().toISOString() });
});

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        connections: io.engine.clientsCount,
        timestamp: new Date().toISOString()
    });
});

// ============================================================
// دوال قاعدة البيانات المساعدة
// ============================================================

async function query(text, params) {
    try {
        const result = await pool.query(text, params);
        return result;
    } catch (error) {
        console.error('❌ Query error:', error.message);
        throw error;
    }
}

async function getSetting(key) {
    const result = await query('SELECT setting_value FROM game_settings WHERE setting_key = $1', [key]);
    return result.rows[0]?.setting_value || null;
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
        settings[row.setting_key] = row.setting_value;
    });
    return settings;
}

// ============================================================
// دوال اللعبة
// ============================================================

const gameState = {
    activeGames: new Map(),
    userLocks: new Map(),
    prizePool: []
};

async function loadPrizes() {
    const result = await query('SELECT * FROM game_prizes WHERE is_active = true ORDER BY weight DESC');
    gameState.prizePool = result.rows;
    return gameState.prizePool;
}

function selectPrize() {
    const pool = gameState.prizePool;
    if (!pool || pool.length === 0) return null;
    
    const totalWeight = pool.reduce((sum, p) => sum + p.weight, 0);
    let random = Math.random() * totalWeight;
    
    for (const prize of pool) {
        random -= prize.weight;
        if (random <= 0) {
            return prize;
        }
    }
    return pool[0];
}

async function checkDepositRequirement(userId) {
    const depositSetting = await getSetting('deposit_required');
    if (!depositSetting || !depositSetting.enabled) {
        return { allowed: true };
    }
    
    const result = await query(
        `SELECT SUM(amount) as total FROM game_deposits 
         WHERE user_id = $1 AND is_used = false`,
        [userId]
    );
    
    const totalDeposits = parseFloat(result.rows[0]?.total || 0);
    const minAmount = depositSetting.min_amount || 1000;
    
    return {
        allowed: totalDeposits >= minAmount,
        required: minAmount,
        current: totalDeposits
    };
}

async function recordPlay(userId, prize, cardsRevealed, matchedSymbol, isWinner) {
    const result = await query(
        `INSERT INTO game_plays (user_id, prize_id, prize_name, prize_value, is_winner, cards_revealed, matched_symbol, game_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
            userId,
            prize?.id || null,
            prize?.prize_name || 'لا جائزة',
            prize?.prize_value || 0,
            isWinner,
            cardsRevealed,
            matchedSymbol || null,
            JSON.stringify({ cardsRevealed, matchedSymbol })
        ]
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
        [
            userId,
            isWinner ? 1 : 0,
            isWinner ? 0 : 1,
            isWinner ? (prize?.prize_value || 0) : 0
        ]
    );
    
    return result.rows[0].id;
}

async function getUserStats(userId) {
    const result = await query(
        `SELECT * FROM user_game_stats WHERE user_id = $1`,
        [userId]
    );
    return result.rows[0] || null;
}

async function getUserPlays(userId, limit = 20) {
    const result = await query(
        `SELECT gp.*, 
         TO_CHAR(gp.play_date, 'YYYY-MM-DD HH24:MI:SS') as formatted_date
         FROM game_plays gp
         WHERE gp.user_id = $1
         ORDER BY gp.play_date DESC
         LIMIT $2`,
        [userId, limit]
    );
    return result.rows;
}

async function getGlobalStats() {
    const result = await query(`
        SELECT 
            COUNT(*) as total_plays,
            SUM(CASE WHEN is_winner THEN 1 ELSE 0 END) as total_wins,
            SUM(CASE WHEN is_winner THEN 0 ELSE 1 END) as total_losses,
            COALESCE(SUM(prize_value), 0) as total_prizes,
            COUNT(DISTINCT user_id) as unique_players
        FROM game_plays
    `);
    return result.rows[0];
}

// ============================================================
// API Routes
// ============================================================

// الحصول على جميع الإعدادات
app.get('/api/settings', async (req, res) => {
    try {
        const settings = await getAllSettings();
        res.json({ success: true, settings });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// تحديث إعداد (للمشرف فقط)
app.post('/api/admin/settings', async (req, res) => {
    try {
        const { userId, key, value } = req.body;
        if (userId !== process.env.ADMIN_ID) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        
        await setSetting(key, value);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// تحديث عدة إعدادات دفعة واحدة
app.post('/api/admin/settings/batch', async (req, res) => {
    try {
        const { userId, settings } = req.body;
        if (userId !== process.env.ADMIN_ID) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        
        for (const [key, value] of Object.entries(settings)) {
            await setSetting(key, value);
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// الحصول على الجوائز
app.get('/api/prizes', async (req, res) => {
    try {
        const prizes = await loadPrizes();
        res.json({ success: true, prizes });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// إدارة الجوائز (للمشرف فقط)
app.post('/api/admin/prizes', async (req, res) => {
    try {
        const { userId, prize } = req.body;
        if (userId !== process.env.ADMIN_ID) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        
        if (prize.id) {
            await query(
                `UPDATE game_prizes 
                 SET prize_name = $1, prize_value = $2, prize_icon = $3, 
                     prize_symbol = $4, weight = $5, is_active = $6
                 WHERE id = $7`,
                [prize.prize_name, prize.prize_value, prize.prize_icon, 
                 prize.prize_symbol, prize.weight, prize.is_active, prize.id]
            );
        } else {
            await query(
                `INSERT INTO game_prizes (prize_name, prize_value, prize_icon, prize_symbol, weight, is_active)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [prize.prize_name, prize.prize_value, prize.prize_icon, 
                 prize.prize_symbol, prize.weight, prize.is_active]
            );
        }
        
        await loadPrizes();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// حذف جائزة
app.delete('/api/admin/prizes/:id', async (req, res) => {
    try {
        const { userId } = req.body;
        if (userId !== process.env.ADMIN_ID) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        
        await query('DELETE FROM game_prizes WHERE id = $1', [req.params.id]);
        await loadPrizes();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// الحصول على بيانات المستخدم
app.get('/api/user/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const isAdmin = userId === process.env.ADMIN_ID;
        
        const depositCheck = await checkDepositRequirement(userId);
        const stats = await getUserStats(userId);
        const plays = await getUserPlays(userId, 10);
        
        res.json({
            success: true,
            user: {
                id: userId,
                isAdmin,
                stats: stats || { total_plays: 0, total_wins: 0, total_losses: 0, total_prize_value: 0 },
                plays,
                depositCheck
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// إحصائيات عامة (للمشرف)
app.get('/api/admin/stats', async (req, res) => {
    try {
        const userId = req.query.userId;
        if (userId !== process.env.ADMIN_ID) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        
        const globalStats = await getGlobalStats();
        const topPlayers = await query(`
            SELECT user_id, total_plays, total_wins, total_prize_value
            FROM user_game_stats
            ORDER BY total_prize_value DESC
            LIMIT 10
        `);
        
        const recentPlays = await query(`
            SELECT gp.*, 
                   TO_CHAR(gp.play_date, 'YYYY-MM-DD HH24:MI:SS') as formatted_date
            FROM game_plays gp
            ORDER BY gp.play_date DESC
            LIMIT 20
        `);
        
        const allPrizes = await query('SELECT * FROM game_prizes ORDER BY weight ASC');
        
        res.json({
            success: true,
            stats: {
                global: globalStats,
                topPlayers: topPlayers.rows,
                recentPlays: recentPlays.rows,
                totalPrizes: gameState.prizePool.length,
                allPrizes: allPrizes.rows
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// تحديث إيداع المستخدم (للمشرف)
app.post('/api/admin/deposit', async (req, res) => {
    try {
        const { userId, targetUserId, amount } = req.body;
        if (userId !== process.env.ADMIN_ID) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        
        await query(
            `INSERT INTO game_deposits (user_id, amount) VALUES ($1, $2)`,
            [targetUserId, amount]
        );
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// Socket.IO - اللعبة في الوقت الفعلي
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

    socket.on('join', async (data) => {
        try {
            userId = data.userId;
            socket.join(`user_${userId}`);
            
            await loadPrizes();
            
            const depositCheck = await checkDepositRequirement(userId);
            if (!depositCheck.allowed) {
                socket.emit('error', {
                    code: 'DEPOSIT_REQUIRED',
                    message: `يجب أن يكون لديك إيداع بقيمة ${depositCheck.required} SYP على الأقل`,
                    required: depositCheck.required,
                    current: depositCheck.current
                });
                return;
            }
            
            if (gameState.activeGames.has(userId)) {
                socket.emit('error', {
                    code: 'GAME_ACTIVE',
                    message: 'لديك لعبة نشطة حالياً'
                });
                return;
            }
            
            // إنشاء لعبة جديدة
            const maxAttemptsSetting = await getSetting('max_attempts');
            const maxAttempts = maxAttemptsSetting?.value || 5;
            
            const cardsCountSetting = await getSetting('cards_count');
            const cardsCount = cardsCountSetting?.value || 12;
            
            gameData = {
                userId,
                cards: [],
                revealed: [],
                matchedPairs: [],
                attempts: 0,
                maxAttempts: maxAttempts,
                isFinished: false
            };
            
            const selectedPrize = selectPrize();
            if (!selectedPrize) {
                socket.emit('error', {
                    code: 'NO_PRIZES',
                    message: 'لا توجد جوائز متاحة حالياً'
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
            const otherSymbols = gameState.prizePool
                .filter(p => p.prize_symbol !== winningSymbol)
                .map(p => p.prize_symbol);
            
            while (cardSymbols.length < cardsCount) {
                const randomSymbol = otherSymbols[Math.floor(Math.random() * otherSymbols.length)];
                if (randomSymbol) {
                    cardSymbols.push(randomSymbol);
                }
            }
            
            // خلط البطاقات
            for (let i = cardSymbols.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [cardSymbols[i], cardSymbols[j]] = [cardSymbols[j], cardSymbols[i]];
            }
            
            gameData.cards = cardSymbols.map((symbol, index) => ({
                id: index,
                symbol: symbol,
                isRevealed: false,
                isMatched: false
            }));
            
            gameData.winningPrize = selectedPrize;
            gameData.winningSymbol = winningSymbol;
            
            gameState.activeGames.set(userId, gameData);
            
            socket.emit('game_started', {
                cards: gameData.cards.map(c => ({ id: c.id, isRevealed: false, isMatched: false })),
                prize: selectedPrize,
                maxAttempts: gameData.maxAttempts,
                cardsCount: cardsCount
            });
            
            console.log(`🎮 Game started for user: ${userId}`);
            
        } catch (error) {
            console.error('❌ Join error:', error);
            socket.emit('error', { code: 'SERVER_ERROR', message: error.message });
        }
    });
    
    socket.on('reveal_card', async (data) => {
        try {
            const { cardId } = data;
            
            if (!userId || !gameState.activeGames.has(userId)) {
                socket.emit('error', { code: 'NO_GAME', message: 'لا توجد لعبة نشطة' });
                return;
            }
            
            const game = gameState.activeGames.get(userId);
            
            if (game.isFinished) {
                socket.emit('error', { code: 'GAME_FINISHED', message: 'انتهت اللعبة' });
                return;
            }
            
            if (game.attempts >= game.maxAttempts) {
                socket.emit('error', { code: 'MAX_ATTEMPTS', message: 'انتهت المحاولات' });
                return;
            }
            
            const card = game.cards[cardId];
            if (!card || card.isRevealed || card.isMatched) {
                socket.emit('error', { code: 'INVALID_CARD', message: 'بطاقة غير صالحة' });
                return;
            }
            
            card.isRevealed = true;
            game.attempts++;
            
            socket.emit('card_revealed', {
                cardId,
                symbol: card.symbol,
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
                game.isFinished = true;
                const prize = gameState.prizePool.find(p => p.prize_symbol === matchedSymbol);
                const isWinner = prize !== null;
                
                await recordPlay(
                    userId,
                    prize,
                    game.attempts,
                    matchedSymbol,
                    isWinner
                );
                
                let matchedCount = 0;
                game.cards.forEach(c => {
                    if (c.symbol === matchedSymbol && c.isRevealed && !c.isMatched) {
                        c.isMatched = true;
                        matchedCount++;
                    }
                });
                
                socket.emit('game_won', {
                    matchedSymbol,
                    prize: prize,
                    matchedCards: game.cards.filter(c => c.isMatched).map(c => c.id),
                    isWinner: true
                });
                
                io.emit('win_notification', {
                    userId,
                    prizeName: prize?.prize_name || 'جائزة',
                    prizeValue: prize?.prize_value || 0,
                    symbol: matchedSymbol
                });
                
                gameState.activeGames.delete(userId);
                console.log(`🏆 Win for user ${userId}: ${prize?.prize_name}`);
                
            } else if (game.attempts >= game.maxAttempts) {
                game.isFinished = true;
                
                await recordPlay(
                    userId,
                    null,
                    game.attempts,
                    null,
                    false
                );
                
                const allCards = game.cards.map(c => ({
                    id: c.id,
                    symbol: c.symbol
                }));
                
                socket.emit('game_lost', {
                    attempts: game.attempts,
                    allCards,
                    message: 'حظ أوفر في المرة القادمة!'
                });
                
                gameState.activeGames.delete(userId);
                console.log(`❌ Loss for user ${userId}`);
            }
            
        } catch (error) {
            console.error('❌ Reveal error:', error);
            socket.emit('error', { code: 'SERVER_ERROR', message: error.message });
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔗 http://localhost:${PORT}`);
    console.log(`👤 Admin ID: ${process.env.ADMIN_ID || '7011476249'}`);
    console.log(`💓 Keep-alive enabled (ping every 5 minutes)`);
});

process.on('SIGINT', () => {
    console.log('🛑 Shutting down gracefully...');
    server.close(() => {
        pool.end();
        process.exit(0);
    });
});
