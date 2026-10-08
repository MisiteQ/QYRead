// 惬意阅读 - 扩展功能路由（明文，便于维护）
// 在线更新：/api/extra/update/*

const express = require('express');

const router = express.Router();

const { authenticateToken } = require('../middleware/auth');
const bookInfoFetcher = require('../services/bookInfoFetcher');

// 在线更新子路由（挂载到 /api/extra/update/*）
router.use('/update', require('./update'));

// 书籍封面/作者自动补全（内嵌优先，联网兜底；只填空缺字段，不覆盖已有值）
// body: { ids?: number[], limit?: number }；不传 ids 时自动处理所有缺失书籍
router.post('/books/enrich-missing', authenticateToken, async (req, res) => {
    try {
        const body = req.body || {};
        const summary = await bookInfoFetcher.enrichMissingBooks(body.ids, body.limit);
        res.json(summary);
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
