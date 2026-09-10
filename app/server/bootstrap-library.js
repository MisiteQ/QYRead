#!/usr/bin/env node
/**
 * 安装引导：把安装向导中选择的「现有书籍文件夹」注册为公共书库并完成首次扫描。
 *
 * 由 cmd/main 在服务启动后后台调用，通过环境变量传参：
 *   BOOKS_LIBRARY_PATH  向导填写的绝对路径（必填，为空则直接退出）
 *   BOOKS_LIBRARY_NAME  书库显示名（默认：我的书库）
 *   DB_PATH             SQLite 数据库路径（与主服务一致）
 *
 * 设计要点：
 *  - 幂等：同路径书库已存在时直接退出，重复执行不会产生重复书库/重复扫描
 *  - 不移动、不修改用户文件；仅读取并把书籍元数据写入数据库
 *  - 与界面「添加公共书库」走完全相同的链路（addScanTask + startWatch）
 */
const fs = require('fs');
const path = require('path');

const TAG = '[BooksBootstrap]';
function log(msg) { console.log(`${TAG} ${msg}`); }
function warn(msg) { console.warn(`${TAG} ${msg}`); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    const raw = (process.env.BOOKS_LIBRARY_PATH || '').trim();
    if (!raw) {
        log('未配置书籍文件夹，跳过');
        return;
    }
    const dir = path.resolve(raw).replace(/\\/g, '/');
    const libName = (process.env.BOOKS_LIBRARY_NAME || '我的书库').trim() || '我的书库';

    if (!fs.existsSync(dir)) {
        warn(`书籍文件夹不存在: ${dir}，跳过（请确认存储盘已挂载，或稍后在书库管理中手动添加）`);
        return;
    }
    let st;
    try { st = fs.statSync(dir); } catch (e) { warn(`无法访问书籍文件夹: ${dir} (${e.message})`); return; }
    if (!st.isDirectory()) { warn(`路径不是文件夹: ${dir}`); return; }
    try {
        fs.accessSync(dir, fs.constants.R_OK | fs.constants.X_OK);
        fs.readdirSync(dir);
    } catch (e) {
        warn(`应用运行用户对书籍文件夹没有读取权限: ${dir} (${e.message})，跳过；请检查文件夹权限后在书库管理中手动添加`);
        return;
    }

    // 数据库模块（与主服务共享同一份 schema/初始化逻辑）
    const dbMod = require('./db');
    const db = dbMod.db;
    await dbMod.initDatabase();

    const all = (sql, params = []) => new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });
    const getOne = (sql, params = []) => new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
    });
    const run = (sql, params = []) => new Promise((resolve, reject) => {
        db.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
    });

    // 幂等：同路径书库已存在则不再重复注册/扫描
    const existing = await getOne('SELECT id FROM libraries WHERE path = ?', [dir]);
    if (existing) {
        log(`书库已存在（id=${existing.id}，path=${dir}），跳过`);
        return;
    }

    // 等待管理员账号就绪（主服务启动时根据向导凭据自动创建，通常几秒内完成）
    let admin = null;
    for (let i = 0; i < 30; i++) {
        admin = await getOne("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
        if (admin) break;
        await sleep(3000);
    }
    if (!admin) {
        warn('在 90 秒内未等到管理员账号创建，放弃自动注册；请在书库管理中手动添加该文件夹');
        return;
    }

    log(`注册公共书库: ${libName} -> ${dir}（owner=admin#${admin.id}）`);
    const res = await run(
        'INSERT INTO libraries (name, path, is_public, created_at) VALUES (?, ?, 1, ?)',
        [libName, dir, Date.now()]
    );
    const libId = res.lastID;

    // 为所有现有用户补授该公共书库的访问权限（initDatabase 的自动同步只在建库时跑一次）
    await run(
        `INSERT OR IGNORE INTO user_library_permissions (user_id, library_id)
         SELECT u.id, ? FROM users u WHERE NOT EXISTS
         (SELECT 1 FROM user_library_permissions p WHERE p.user_id = u.id AND p.library_id = ?)`,
        [libId, libId]
    );

    // 启动文件监听（与界面添加书库后的行为一致）
    try {
        const { startWatch } = require('./utils/watcher');
        startWatch(libId, dir);
        log('文件监听已启动');
    } catch (e) {
        warn(`启动文件监听失败（不影响首次导入）: ${e.message}`);
    }

    // 首次全量扫描（扫描器本身对已存在文件幂等）
    const { addScanTask, getScanStatus } = require('./utils/scanQueue');
    addScanTask(libId, dir, admin.id, db);
    log('首次扫描任务已入队，等待完成…');

    // 等待扫描终态；大书库可能耗时较长，兜底 2 小时后退出（任务已在队列中推进）
    const deadline = Date.now() + 2 * 60 * 60 * 1000;
    let last = '';
    while (Date.now() < deadline) {
        await sleep(5000);
        const s = getScanStatus(libId);
        if (!s) continue;
        const line = `扫描中 ${s.status} ${s.progress || 0}% (${s.processed || 0}/${s.total || 0}) ${s.currentFile || ''}`;
        if (line !== last) { log(line); last = line; }
        if (s.status === 'completed') {
            log(`扫描完成：新增 ${s.added || 0}，跳过 ${s.skipped || 0}，修复 ${s.repaired || 0}`);
            return;
        }
        if (s.status === 'error') {
            warn('扫描以错误状态结束，请稍后在书库管理中重新扫描');
            process.exitCode = 1;
            return;
        }
    }
    warn('等待扫描完成超时（2 小时），引导脚本退出，扫描将随主服务继续/下次重启后可手动重试');
    process.exitCode = 1;
}

main().catch(err => {
    warn(`引导失败: ${err && err.stack ? err.stack : err}`);
    process.exitCode = 1;
});
