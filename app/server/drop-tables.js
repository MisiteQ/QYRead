// 启动后异步清理旧版本遗留数据表（AI / 成就 / 读后感）
// 这些功能已从代码中整体移除，但老用户数据库里可能还残留对应表，启动后统一 DROP。
// cmd/main 里会在 sleep 10s 后启动此脚本（不阻塞主服务，保守等待 initDatabase 完成所有迁移）。

const path = require('path');
const fs = require('fs');
const dbPath = process.env.DB_PATH;
if (!dbPath || !fs.existsSync(dbPath)) {
    console.warn('[drop-tables] DB_PATH 未设置或数据库文件不存在，跳过');
    process.exit(0);
}

// 懒加载 sqlite3（不要因为 require 失败让脚本崩掉）
let Database;
try { Database = require('sqlite3').Database; }
catch (e) { console.warn('[drop-tables] sqlite3 未加载:', e.message); process.exit(0); }

const db = new Database(dbPath);
// 启动期服务可能正在初始化/扫描（长事务），DROP 会拿到 SQLITE_BUSY——给足等待时间，避免静默失败
db.configure('busyTimeout', 30000);
const tables = [
    'ai_sessions', 'ai_config', 'ai_settings', 'ai_status',
    'ai_memories', 'user_memories', 'ai_usage', 'ai_log',
    'ai_cache', 'ai_books_metadata', 'metadata_complete',
    'achievements', 'achievement_records', 'achievement_user_records',
    'achievement_config', 'achievement_conditions', 'user_achievements',
    'book_reviews',
];

let pending = tables.length + 1;
function done() { if (--pending <= 0) { console.log('[drop-tables] finished'); db.close(() => process.exit(0)); } }
db.serialize(() => {
    tables.forEach(t => {
        db.run(`DROP TABLE IF EXISTS "${t}"`, (err) => {
            if (err) console.warn(`[drop-tables] DROP ${t} failed: ${err.message}`);
            done();
        });
    });
    // 清理 sqlite_sequence 里的自增记录（防止下次如果又 CREATE TABLE 时从旧 id 开始）
    db.run(`DELETE FROM sqlite_sequence WHERE name IN (${tables.map(()=>'?').join(',')})`, tables, (err) => {
        if (err) console.warn(`[drop-tables] sqlite_sequence cleanup failed: ${err.message}`);
        done();
    });
});
