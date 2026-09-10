// 成就系统已彻底移除（v0.1.2 起）
// 文件必须保留空 Router：混淆 server.js 会 require('./routes/achievements') 并挂载，
// 删除文件会导致 MODULE_NOT_FOUND 崩溃。所有端点返回 404/空响应。
// 启动时在 DB 中清理 achievements 相关数据表（迁移在 initDatabase 之后执行）。

const express = require('express');
const router = express.Router();

// ---- 启动时迁移：删除成就相关表（幂等） ----
try {
    const db = require('../db').db;
    const candidateTables = [
        'achievements', 'achievement_records', 'achievement_user_records',
        'achievement_config', 'achievement_conditions', 'achievement_unlocks',
    ];
    for (const t of candidateTables) {
        try { db.run(`DROP TABLE IF EXISTS "${t}"`); } catch (_) {}
    }
    console.log('[qyread] Achievements tables cleaned up (routes/achievements.js migration)');
} catch (e) {
    console.warn('[qyread] Achievements cleanup deferred: ' + e.message);
}

module.exports = router;
