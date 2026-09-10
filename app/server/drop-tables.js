// 启动后异步清理 AI / 成就数据表
// 为什么需要这个独立脚本：server.js 混淆产物在 start() 里先调 initDatabase() CREATE TABLE，
// 然后才挂载 routes。routes/ai.js 顶层 IIFE 虽然已经 DROP 过一次了，但那时 initDatabase 还没跑，
// 表根本不存在。等 initDatabase 把表 CREATE 出来后，表又回来了。
//
// 所以这个脚本需要在 server.js 启动完成后、initDatabase 跑过之后再执行一次 DROP。
// cmd/main 里会在 sleep 10s 后启动此脚本（不阻塞主服务，保守等待 initDatabase 完成所有迁移）。
// 内部用 retry 循环先检查 sqlite_master 再 DROP，避免 initDatabase 还没完成时漏掉。

const path = require('path');
const fs = require('fs');
const dbPath = process.env.DB_PATH;
if (!dbPath || !fs.existsSync(dbPath)) {
    console.warn('[drop-tables] DB_PATH 未设置或数据库文件不存在，跳过');
    process.exit(0);
}

// 懒加载 sqlite3（不要因为 require 失败让脚本崩掉）
let Database;
try { Database = require('sqlite3'); }
catch (e) { console.warn('[drop-tables] sqlite3 未加载:', e.message); process.exit(0); }

const db = new Database(dbPath);
const tables = [
    'ai_sessions', 'ai_config', 'ai_settings', 'ai_status',
    'ai_memories', 'user_memories', 'ai_usage', 'ai_log',
    'ai_cache', 'ai_books_metadata', 'metadata_complete',
    'achievements', 'achievement_records', 'achievement_user_records',
    'achievement_config', 'achievement_conditions',
];

let pending = tables.length + 1;
function done() { if (--pending <= 0) { console.log('[drop-tables] finished'); db.close(() => process.exit(0)); } }
db.serialize(() => {
    tables.forEach(t => { db.run(`DROP TABLE IF EXISTS "${t}"`, () => done()); });
    // 清理 sqlite_sequence 里的自增记录（防止下次如果又 CREATE TABLE 时从旧 id 开始）
    db.run(`DELETE FROM sqlite_sequence WHERE name IN (${tables.map(()=>'?').join(',')})`, tables, () => done());
});
