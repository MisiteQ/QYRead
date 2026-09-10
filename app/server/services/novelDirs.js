// 小说下载目录服务
// 提供：可选目录列表（默认上传目录 + 用户可访问的书库 + 存储盘浏览）、
//       目录安全校验、把非书库目录自动注册为当前用户的私有书库（注册后由
//       文件监听/扫描链路自动入库，与界面「添加书库」完全同链路）。
const fs = require('fs');
const path = require('path');

function norm(p) {
    return path.resolve(String(p || '')).replace(/\\/g, '/');
}

function storageRoot() {
    return norm(process.env.STORAGE_ROOT || process.env.DATA_DIR || path.join(__dirname, '..', '..'));
}

function uploadDir() {
    return norm(process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads'));
}

// 是否位于允许的存储根之内（防穿越）
function isWithinRoot(target, root) {
    const t = norm(target);
    const r = norm(root);
    return t === r || t.startsWith(r + '/');
}

function isPathInside(child, parent) {
    const c = norm(child);
    const p = norm(parent);
    return c === p || c.startsWith(p + '/');
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
    });
}

// 当前用户可见的书库（公共库 / 已授权库；管理员可见全部）
async function accessibleLibraries(db, user) {
    const sql = user && user.role === 'admin'
        ? 'SELECT id, name, path, is_public FROM libraries ORDER BY id'
        : `SELECT l.id, l.name, l.path, l.is_public FROM libraries l
           WHERE l.is_public = 1
              OR EXISTS (SELECT 1 FROM user_library_permissions p
                         WHERE p.library_id = l.id AND p.user_id = ?)
           ORDER BY l.id`;
    const rows = await all(db, sql, user && user.role !== 'admin' ? [user.id] : []);
    return rows.map(r => ({ ...r, path: norm(r.path) }))
        .filter(r => r.path && r.path !== '.');
}

// 找目录命中的最深一层书库（下载到书库子目录时仍被递归监听覆盖）
function findLibraryForDir(libs, dir) {
    const d = norm(dir);
    let hit = null;
    for (const l of libs) {
        if (isPathInside(d, l.path) && (!hit || l.path.length > hit.path.length)) hit = l;
    }
    return hit;
}

// 候选下载目录
async function listTargets(db, user) {
    const libs = await accessibleLibraries(db, user);
    const up = uploadDir();
    const targets = [];
    targets.push({
        type: 'upload',
        path: up,
        name: '应用默认下载目录',
        libraryId: null,
        exists: safeIsDir(up),
    });
    for (const l of libs) {
        targets.push({
            type: 'library',
            path: l.path,
            name: l.name,
            libraryId: l.id,
            isPublic: !!l.is_public,
            exists: safeIsDir(l.path),
        });
    }
    return { root: storageRoot(), targets, libraries: libs };
}

function safeIsDir(p) {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// 浏览存储盘内某一层的子目录（一层，不递归）
async function browse(db, user, rawPath) {
    const root = storageRoot();
    const libs = await accessibleLibraries(db, user);
    let cur = rawPath ? norm(rawPath) : root;
    if (!isWithinRoot(cur, root)) {
        const err = new Error('只能浏览应用存储空间内的文件夹');
        err.statusCode = 403;
        throw err;
    }
    if (!safeIsDir(cur)) {
        const err = new Error('文件夹不存在或不可访问');
        err.statusCode = 404;
        throw err;
    }
    let names = [];
    try { names = fs.readdirSync(cur, { withFileTypes: true }); }
    catch (e) {
        const err = new Error('无法读取该文件夹: ' + e.message);
        err.statusCode = 403;
        throw err;
    }
    const dirs = names.filter(d => d.isDirectory()).map(d => {
        const full = norm(path.join(cur, d.name));
        const lib = findLibraryForDir(libs, full);
        return {
            name: d.name,
            path: full,
            libraryId: lib ? lib.id : null,
            libraryName: lib ? lib.name : null,
        };
    }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    return {
        path: cur,
        root,
        parent: cur === root ? null : norm(path.dirname(cur)),
        canGoUp: cur !== root,
        inRoot: true,
        dirs,
    };
}

// 把一个存储盘内的非书库目录注册为当前用户的私有书库
async function registerPrivateLibrary(db, user, dir) {
    const name = path.basename(dir) || '小说下载';
    const res = await run(db,
        'INSERT INTO libraries (name, path, is_public, created_at) VALUES (?, ?, 0, ?)',
        [name, dir, Date.now()]);
    const libId = res.lastID;
    await run(db,
        'INSERT OR IGNORE INTO user_library_permissions (user_id, library_id) VALUES (?, ?)',
        [user.id, libId]);
    let watchStarted = false;
    try {
        require('../utils/watcher').startWatch(libId, dir);
        watchStarted = true;
    } catch (e) {
        console.warn('[NovelDirs] 启动文件监听失败:', e.message);
    }
    try {
        require('../utils/scanQueue').addScanTask(libId, dir, user.id, db);
    } catch (e) {
        console.warn('[NovelDirs] 扫描任务入队失败:', e.message);
    }
    return { id: libId, name, path: dir, isPublic: false, created: true, watchStarted };
}

// 解析并校验最终下载目录：
//  - 命中当前用户可访问的书库（含其子目录）→ 直接放行（监听已覆盖，自动入库）
//  - 否则必须位于存储盘根内，目录会自动创建并注册为当前用户的私有书库
async function resolveDownloadDir(db, user, rawDir) {
    const root = storageRoot();
    const dir = norm(rawDir || uploadDir());
    const libs = await accessibleLibraries(db, user);
    const hitLib = findLibraryForDir(libs, dir);
    if (!hitLib && !isWithinRoot(dir, root)) {
        const err = new Error('下载目录必须位于可访问的书库或应用存储空间内');
        err.statusCode = 400;
        throw err;
    }
    try { fs.mkdirSync(dir, { recursive: true }); }
    catch (e) {
        const err = new Error('无法创建下载文件夹: ' + e.message);
        err.statusCode = 400;
        throw err;
    }
    try { fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK); }
    catch (e) {
        const err = new Error('下载文件夹不可读写: ' + e.message);
        err.statusCode = 403;
        throw err;
    }
    let lib = hitLib;
    let created = false;
    if (!lib && user) {
        lib = await registerPrivateLibrary(db, user, dir);
        created = true;
    }
    return {
        dir,
        libraryId: lib ? lib.id : null,
        libraryName: lib ? lib.name : null,
        libraryCreated: created,
    };
}

// 校验“已下载文件管理”的目录（只读浏览场景：不自动建库）
async function resolveManagedDir(db, user, rawDir) {
    const root = storageRoot();
    const dir = norm(rawDir || uploadDir());
    const libs = await accessibleLibraries(db, user);
    const lib = findLibraryForDir(libs, dir);
    if (!lib && !isWithinRoot(dir, root)) {
        const err = new Error('目录超出允许范围');
        err.statusCode = 400;
        throw err;
    }
    if (!safeIsDir(dir)) {
        const err = new Error('文件夹不存在');
        err.statusCode = 404;
        throw err;
    }
    return { dir, libraryId: lib ? lib.id : null, libraryName: lib ? lib.name : null };
}

module.exports = {
    storageRoot,
    uploadDir,
    isWithinRoot,
    accessibleLibraries,
    findLibraryForDir,
    listTargets,
    browse,
    resolveDownloadDir,
    resolveManagedDir,
};
