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
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling']
});

// ============================================================
// إعدادات الأمان والحماية
// ============================================================

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));
app.use(cors());
app.use(compression());
app.use(express.json());
app.use(express.static('public'));

// حماية من الهجمات
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
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
    connectionTimeoutMillis: 2000
});

// اختبار الاتصال وإنشاء الجداول
async function initDatabase() {
    try {
        await pool.query('SELECT 1');
        console.log('✅ Connected to PostgreSQL');

        // إنشاء الجداول فقط إذا لم تكن موجودة
        await pool.query(`
            -- جدول إعدادات اللعبة
            CREATE TABLE IF NOT EXISTS game_settings (
                id SERIAL PRIMARY KEY,
                setting_key VARCHAR(50) UNIQUE NOT NULL,
                setting_value JSONB,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- جدول الجوائز
            CREATE TABLE IF NOT EXISTS game_prizes (
                id SERIAL PRIMARY KEY,
                prize_name VARCHAR(100) NOT NULL,
                prize_value INTEGER NOT NULL,
                prize_icon VARCHAR(50) NOT NULL,
                prize_symbol VARCHAR(10) NOT NULL,
                weight INTEGER DEFAULT 1,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- جدول سجل اللعب
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
            );

            -- جدول إحصائيات المستخدمين
            CREATE TABLE IF NOT EXISTS user_game_stats (
                user_id VARCHAR(50) PRIMARY KEY,
                total_plays INTEGER DEFAULT 0,
                total_wins INTEGER DEFAULT 0,
                total_losses INTEGER DEFAULT 0,
                total_prize_value INTEGER DEFAULT 0,
                last_play TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- جدول الإيداعات (لربطها باللعبة)
            CREATE TABLE IF NOT EXISTS game_deposits (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(50) NOT NULL,
                amount DECIMAL(20,2) NOT NULL,
                deposit_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_used BOOLEAN DEFAULT false
            );
        `);

        // إدراج الجوائز الافتراضية إذا كانت الجداول فارغة
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

        // إدراج إعدادات اللعبة الافتراضية
        const settingsCheck = await pool.query(`SELECT COUNT(*) FROM game_settings WHERE setting_key = 'deposit_required'`);
        if (parseInt(settingsCheck.rows[0].count) === 0) {
            await pool.query(`
                INSERT INTO game_settings (setting_key, setting_value) VALUES
                ('deposit_required', '{"enabled": false, "min_amount": 1000}'),
                ('loading_image', '{"url": "https://i.imgur.com/placeholder.jpg"}'),
                ('card_back_image', '{"url": "https://i.imgur.com/cardback.jpg"}'),
                ('game_animation', '{"enabled": true, "duration": 3000}')
            `);
            console.log('✅ Default settings inserted');
        }

        console.log('✅ All tables created successfully');

    } catch (error) {
        console.error('❌ Database initialization error:', error.message);
        process.exit(1);
    }
}

initDatabase();

// ============================================================
// دوال مساعدة لقاعدة البيانات
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

// ============================================================
// دوال اللعبة
// ============================================================

const gameState = {
    activeGames: new Map(),
    userLocks: new Map(),
    prizePool: []
};

// تحميل الجوائز من قاعدة البيانات
async function loadPrizes() {
    const result = await query('SELECT * FROM game_prizes WHERE is_active = true ORDER BY weight DESC');
    gameState.prizePool = result.rows;
    return gameState.prizePool;
}

// اختيار جائزة عشوائية حسب الوزن
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

// التحقق من شرط الإيداع
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

// تسجيل لعب جديد
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
    
    // تحديث إحصائيات المستخدم
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

// الحصول على إحصائيات المستخدم
async function getUserStats(userId) {
    const result = await query(
        `SELECT * FROM user_game_stats WHERE user_id = $1`,
        [userId]
    );
    return result.rows[0] || null;
}

// الحصول على سجل لعب المستخدم
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

// الحصول على إحصائيات عامة
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

// الحصول على إعدادات اللعبة
app.get('/api/settings', async (req, res) => {
    try {
        const settings = {
            loadingImage: await getSetting('loading_image'),
            cardBackImage: await getSetting('card_back_image'),
            depositRequired: await getSetting('deposit_required'),
            gameAnimation: await getSetting('game_animation')
        };
        res.json({ success: true, settings });
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

// التحقق من المستخدم
app.get('/api/user/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const isAdmin = userId === process.env.ADMIN_ID;
        
        // التحقق من شرط الإيداع
        const depositCheck = await checkDepositRequirement(userId);
        
        // إحصائيات المستخدم
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

// إدارة الجوائز (للمشرف فقط)
app.post('/api/admin/prizes', async (req, res) => {
    try {
        const { userId, prize } = req.body;
        if (userId !== process.env.ADMIN_ID) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        
        if (prize.id) {
            // تحديث جائزة موجودة
            await query(
                `UPDATE game_prizes 
                 SET prize_name = $1, prize_value = $2, prize_icon = $3, 
                     prize_symbol = $4, weight = $5, is_active = $6
                 WHERE id = $7`,
                [prize.prize_name, prize.prize_value, prize.prize_icon, 
                 prize.prize_symbol, prize.weight, prize.is_active, prize.id]
            );
        } else {
            // إضافة جائزة جديدة
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

// إدارة الإعدادات (للمشرف فقط)
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
        
        res.json({
            success: true,
            stats: {
                global: globalStats,
                topPlayers: topPlayers.rows,
                recentPlays: recentPlays.rows,
                totalPrizes: gameState.prizePool.length
            }
        });
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
    
    socket.on('join', async (data) => {
        try {
            userId = data.userId;
            socket.join(`user_${userId}`);
            
            // تحميل الجوائز
            await loadPrizes();
            
            // التحقق من شرط الإيداع
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
            
            // التحقق من وجود لعبة نشطة
            if (gameState.activeGames.has(userId)) {
                socket.emit('error', {
                    code: 'GAME_ACTIVE',
                    message: 'لديك لعبة نشطة حالياً'
                });
                return;
            }
            
            // إنشاء لعبة جديدة
            gameData = {
                userId,
                cards: [],
                revealed: [],
                matchedPairs: [],
                attempts: 0,
                maxAttempts: 5,
                isFinished: false
            };
            
            // إنشاء البطاقات
            const symbols = gameState.prizePool.map(p => p.prize_symbol);
            const selectedPrize = selectPrize();
            
            if (!selectedPrize) {
                socket.emit('error', {
                    code: 'NO_PRIZES',
                    message: 'لا توجد جوائز متاحة حالياً'
                });
                return;
            }
            
            // اختيار 3 رموز متطابقة للفوز
            const winningSymbol = selectedPrize.prize_symbol;
            
            // إنشاء 12 بطاقة (3 متطابقة + 9 عشوائية)
            const cardSymbols = [];
            for (let i = 0; i < 3; i++) {
                cardSymbols.push(winningSymbol);
            }
            
            // ملء الباقي برموز عشوائية
            const otherSymbols = gameState.prizePool
                .filter(p => p.prize_symbol !== winningSymbol)
                .map(p => p.prize_symbol);
            
            while (cardSymbols.length < 12) {
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
            
            // إرسال بيانات اللعبة للعميل
            socket.emit('game_started', {
                cards: gameData.cards.map(c => ({ id: c.id, isRevealed: false, isMatched: false })),
                prize: selectedPrize,
                maxAttempts: gameData.maxAttempts
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
            
            // كشف البطاقة
            card.isRevealed = true;
            game.attempts++;
            
            // إرسال تحديث للعميل
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
                // فوز!
                game.isFinished = true;
                
                // تحديد الجائزة
                const prize = gameState.prizePool.find(p => p.prize_symbol === matchedSymbol);
                const isWinner = prize !== null;
                
                // تسجيل اللعب
                await recordPlay(
                    userId,
                    prize,
                    game.attempts,
                    matchedSymbol,
                    isWinner
                );
                
                // تحديث حالة البطاقات المتطابقة
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
                
                // بث إشعار الفوز للجميع (اختياري)
                io.emit('win_notification', {
                    userId,
                    prizeName: prize?.prize_name || 'جائزة',
                    prizeValue: prize?.prize_value || 0,
                    symbol: matchedSymbol
                });
                
                // تنظيف
                gameState.activeGames.delete(userId);
                console.log(`🏆 Win for user ${userId}: ${prize?.prize_name}`);
                
            } else if (game.attempts >= game.maxAttempts) {
                // خسارة
                game.isFinished = true;
                
                // تسجيل اللعب (خسارة)
                await recordPlay(
                    userId,
                    null,
                    game.attempts,
                    null,
                    false
                );
                
                // الكشف عن جميع البطاقات
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
        console.log('🔴 Disconnected:', socket.id);
        if (userId && gameState.activeGames.has(userId)) {
            // تنظيف اللعبة عند انقطاع الاتصال
            gameState.activeGames.delete(userId);
            console.log(`🧹 Cleaned game for user ${userId}`);
        }
    });
});

// ============================================================
// تشغيل الخادم
// ============================================================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔗 http://localhost:${PORT}`);
    console.log(`👤 Admin ID: ${process.env.ADMIN_ID}`);
});
