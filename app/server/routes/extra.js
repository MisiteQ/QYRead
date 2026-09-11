// 惬意阅读 - 扩展功能路由（明文，便于维护）
// 整本书读后感：/api/extra/reviews*

const express = require('express');
const path = require('path');

const router = express.Router();

const { db, dbGet, dbAll, dbRun } = require('../db');
const { authenticateToken } = require('../middleware/auth');

const EXTRA_UI_DIR = path.join(__dirname, '..', 'extra-ui');

// 在线更新子路由（挂载到 /api/extra/update/*）
router.use('/update', require('./update'));

// ---------- 数据表（幂等） ----------
db.run(`CREATE TABLE IF NOT EXISTS book_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    book_id INTEGER NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    updated_at INTEGER,
    UNIQUE(user_id, book_id)
)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_book_reviews_user ON book_reviews(user_id)`);

async function getBook(id) {
    return dbGet('SELECT * FROM books WHERE id = ?', [id]);
}

// 读后感独立页面
router.get('/reviews/page', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(EXTRA_UI_DIR, 'reviews.html'));
});

// 我的读后感列表（带书籍信息）
router.get('/reviews', authenticateToken, async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT r.id, r.book_id, r.content, r.updated_at,
                    b.title, b.author, b.format, b.cover
             FROM book_reviews r LEFT JOIN books b ON b.id = r.book_id
             WHERE r.user_id = ? ORDER BY r.updated_at DESC`,
            [req.user.id]
        );
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 单本书的读后感
router.get('/reviews/:bookId', authenticateToken, async (req, res) => {
    try {
        const row = await dbGet(
            'SELECT * FROM book_reviews WHERE user_id = ? AND book_id = ?',
            [req.user.id, req.params.bookId]
        );
        res.json(row || { content: '' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 新建/更新读后感
router.put('/reviews/:bookId', authenticateToken, async (req, res) => {
    try {
        const bookId = parseInt(req.params.bookId, 10);
        const content = String((req.body && req.body.content) || '').slice(0, 100000);
        const book = await getBook(bookId);
        if (!book) return res.status(404).json({ error: '书籍不存在' });
        const now = Date.now();
        await dbRun(
            `INSERT INTO book_reviews (user_id, book_id, content, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id, book_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
            [req.user.id, bookId, content, now]
        );
        res.json({ success: true, updated_at: now, chars: content.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 删除读后感
router.delete('/reviews/:bookId', authenticateToken, async (req, res) => {
    try {
        await dbRun('DELETE FROM book_reviews WHERE user_id = ? AND book_id = ?',
            [req.user.id, req.params.bookId]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 启动后台自动检查更新（延迟 30 秒等数据库/服务就绪）
try {
    const updater = require('../services/updater');
    setTimeout(() => { try { updater.startAutoCheck(); } catch (e) {} }, 30000);
} catch (e) {}

module.exports = router;
