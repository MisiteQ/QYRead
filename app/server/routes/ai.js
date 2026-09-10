// AI 助手功能已彻底移除（v0.1.2 起）
// 文件必须保留空 Router：混淆 server.js 会 require('./routes/ai') 并挂载 /api/ai/*，
// 删除文件会导致 MODULE_NOT_FOUND 崩溃。所有端点返回 404/空响应。
// 启动时在 DB 中清理 ai 相关数据表（迁移已在 initDatabase 之后执行）。

const express = require('express');
const router = express.Router();

// ---- 启动时迁移：删除 AI 相关表（幂等） ----
try {
    const db = require('../db').db;
    const candidateTables = [
        'ai_sessions', 'ai_config', 'ai_settings', 'ai_status',
        'ai_memories', 'user_memories', 'user_ai_memories',
        'ai_usage', 'ai_log', 'ai_cache',
        'ai_books_metadata', 'metadata_complete',
    ];
    for (const t of candidateTables) {
        try { db.run(`DROP TABLE IF EXISTS "${t}"`); } catch (_) {}
    }
    // 尝试按前缀通配（SQLite 不支持直接通配，但 IF EXISTS 会跳过不存在的）
    const aiPrefixed = ['ai_'];
    for (const prefix of aiPrefixed) {
        try {
            // 先查 sqlite_master 里的真实表名
            const stmt = db.prepare && db.prepare('SELECT name FROM sqlite_master WHERE type="table" AND name LIKE ?');
            if (stmt) {
                const rows = stmt.all(prefix + '%') || [];
                for (const row of rows) {
                    try { db.run(`DROP TABLE IF EXISTS "${row.name}"`); } catch (_) {}
                }
            }
        } catch (_) {}
    }
    console.log('[qyread] AI tables cleaned up (routes/ai.js migration)');
} catch (e) {
    // db 加载失败时忽略（可能是内存 db 或还在迁移途中）
    console.warn('[qyread] AI cleanup deferred: ' + e.message);
}

module.exports = router;
