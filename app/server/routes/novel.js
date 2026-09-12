// 小说搜索下载路由
// 提供与 go-novel 兼容的 REST API + SSE 进度推送 + 独立 HTML 界面

const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();

const rules = require('../services/novelRulesLoader');
const searcher = require('../services/novelSearcher');
const { fetchBookInfo, fetchToc } = require('../services/novelCrawler');
const downloader = require('../services/novelDownloader');
const progress = require('../services/novelProgressManager');
const dirs = require('../services/novelDirs');

const { authenticateToken, AUTH_COOKIE_NAME } = require('../middleware/auth');
const jwt = require('jsonwebtoken');

function getDb() {
    return require('../db').db;
}

// SSE 专用鉴权：EventSource 无法设置 Authorization 头，支持 query.token + cookie
function authSSE(req, res, next) {
    // 复用主 auth 的 cookie/header 逻辑
    const authHeader = req.headers['authorization'];
    let token = authHeader && authHeader.split(' ')[1];
    if (!token && req.query.token) token = req.query.token;
    if (!token && req.cookies) {
        token = req.cookies[AUTH_COOKIE_NAME] || req.cookies['token'];
    }
    if (!token) return res.status(401).json({ error: '未登录' });
    // 复用主应用的 JWT secret（从同目录 .secret 读取或环境变量）
    let secret = process.env.JWT_SECRET;
    if (!secret) {
        const pkgvar = process.env.TRIM_PKGVAR || path.join(__dirname, '..');
        const secretFile = path.join(pkgvar, '.secret');
        try { if (fs.existsSync(secretFile)) secret = fs.readFileSync(secretFile, 'utf8').trim(); } catch {}
    }
    if (!secret) { return res.status(500).json({ error: '服务端未配置 JWT 密钥' }); }
    jwt.verify(token, secret, (err, user) => {
        if (err) return res.status(403).json({ error: 'token无效' });
        req.user = user;
        next();
    });
}

// 独立 HTML 界面（无需登录即可访问，便于直接使用）
router.get('/page', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, '..', 'novel-ui', 'index.html'));
});

// 列出所有书源（带分类，供管理 UI 增删改查）
router.get('/sources', (req, res) => {
    const all = rules.listAllWithCategory().map(s => ({
        id: s.id,
        category: s.category,
        name: s.name,
        url: s.url,
        language: s.language,
        comment: s.comment,
        searchable: !!(s.search && !s.search.disabled),
        needProxy: s.category === 'proxy' || rules.needsProxy(s.id),
    }));
    res.json({ sources: all });
});

// 获取单个书源完整规则（go-novel JSON 格式）
router.get('/sources/:category/:id', authenticateToken, (req, res) => {
    const s = rules.getSourceDetail(req.params.category, req.params.id);
    if (!s) return res.status(404).json({ error: '书源不存在' });
    res.json({ source: s });
});

// 新增书源；body: { category, rule }，rule 为 go-novel 规则对象
router.post('/sources', authenticateToken, (req, res) => {
    const { category, rule } = req.body || {};
    if (!category || !rule || typeof rule !== 'object') {
        return res.status(400).json({ error: '需要 category 和 rule' });
    }
    try {
        const created = rules.addSource(category, rule);
        res.json({ source: created });
    } catch (e) {
        res.status(400).json({ error: '新增失败: ' + e.message });
    }
});

// 更新书源；body: { rule, newCategory? }，newCategory 用于跨分类移动
router.put('/sources/:category/:id', authenticateToken, (req, res) => {
    const { category, id } = req.params;
    const { rule, newCategory } = req.body || {};
    if (!rule || typeof rule !== 'object') {
        return res.status(400).json({ error: '需要 rule' });
    }
    try {
        const updated = rules.updateSource(category, id, rule, newCategory);
        res.json({ source: updated });
    } catch (e) {
        res.status(400).json({ error: '更新失败: ' + e.message });
    }
});

// 删除书源
router.delete('/sources/:category/:id', authenticateToken, (req, res) => {
    const { category, id } = req.params;
    try {
        rules.deleteSource(category, id);
        res.json({ ok: true });
    } catch (e) {
        res.status(400).json({ error: '删除失败: ' + e.message });
    }
});

// 可选下载目录：应用默认目录 + 用户可访问的书库 + 存储盘根
router.get('/dirs', authenticateToken, async (req, res) => {
    try {
        const data = await dirs.listTargets(getDb(), req.user);
        let savedDir = null;
        try {
            const pref = await new Promise((resolve, reject) => {
                getDb().get(
                    'SELECT value FROM user_preferences WHERE user_id=? AND key=?',
                    [req.user.id, 'novel_download_dir'],
                    (err, row) => err ? reject(err) : resolve(row)
                );
            });
            if (pref && pref.value) {
                try { savedDir = JSON.parse(pref.value); } catch { savedDir = pref.value; }
            }
        } catch { /* 偏好表不可用时忽略 */ }
        res.json({ ...data, savedDir, defaultDir: dirs.uploadDir() });
    } catch (e) {
        console.error('[NovelRoute] list dirs error:', e);
        res.status(500).json({ error: '获取下载目录失败: ' + e.message });
    }
});

// 浏览存储盘内的子目录（供目录选择器）
router.get('/dirs/browse', authenticateToken, async (req, res) => {
    try {
        const data = await dirs.browse(getDb(), req.user, req.query.path);
        res.json(data);
    } catch (e) {
        res.status(e.statusCode || 500).json({ error: e.message });
    }
});

// 聚合搜索（需登录）
router.get('/search', authenticateToken, async (req, res) => {
    const { q, includeProxy = '0' } = req.query;
    if (!q || q.trim().length < 2) {
        return res.status(400).json({ error: '关键词至少 2 个字符' });
    }
    try {
        const results = await searcher.aggregatedSearch(q.trim(), {
            includeProxy: includeProxy === '1' || includeProxy === 'true',
            limitPerSource: 10,
            timeoutMs: 15000,
        });
        res.json({ query: q, total: results.length, results });
    } catch (e) {
        console.error('[NovelRoute] search error:', e);
        res.status(500).json({ error: '搜索失败: ' + e.message });
    }
});

// 获取书籍详情 + 目录预览
router.get('/book', authenticateToken, async (req, res) => {
    const { sourceId, bookUrl } = req.query;
    if (!sourceId || !bookUrl) {
        return res.status(400).json({ error: '需要 sourceId 和 bookUrl' });
    }
    const source = rules.getSourceById(sourceId);
    if (!source) return res.status(404).json({ error: '书源不存在' });

    try {
        const { info, doc, finalUrl } = await fetchBookInfo(source, bookUrl);
        const toc = await fetchToc(source, info, doc, bookUrl);
        res.json({ info, tocCount: toc.length, toc: toc.slice(0, 50) }); // 预览前 50 章
    } catch (e) {
        console.error('[NovelRoute] book info error:', e);
        res.status(500).json({ error: '获取书籍信息失败: ' + e.message });
    }
});

// 触发下载（异步，返回 taskId，进度走 SSE）
// body: { sourceId, bookUrl, bookName, extname, clientId, dir }
router.post('/download', authenticateToken, async (req, res) => {
    const { sourceId, bookUrl, bookName, extname = 'epub', clientId, dir } = req.body;
    if (!sourceId || !bookUrl) {
        return res.status(400).json({ error: '需要 sourceId 和 bookUrl' });
    }
    try {
        const out = await downloader.startDownload({
            sourceId,
            bookUrl,
            bookName: typeof bookName === 'string' ? bookName.slice(0, 120) : '',
            extname,
            clientId: clientId || `u${req.user?.id || 0}`,
            dir: dir || null,
            userId: req.user?.id,
            userRole: req.user?.role,
            db: getDb(),
        });
        res.json({
            taskId: out.taskId,
            dir: out.dir,
            libraryId: out.libraryId,
            libraryName: out.libraryName,
            libraryCreated: out.libraryCreated,
            message: '下载已开始，请通过 SSE 接收进度',
        });
    } catch (e) {
        console.error('[NovelRoute] start download error:', e);
        res.status(e.statusCode || 500).json({ error: '启动下载失败: ' + e.message });
    }
});

// 查询任务状态
router.get('/task/:taskId', authenticateToken, (req, res) => {
    const task = progress.getTask(req.params.taskId);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    res.json(task);
});

// 任务控制：暂停 / 继续 / 取消（仅任务所属用户可操作）
function controlTask(req, res, action) {
    const task = progress.getTask(req.params.taskId);
    if (!task) return res.status(404).json({ error: '任务不存在或已过期' });
    if (task.userId && req.user?.id && String(task.userId) !== String(req.user.id)) {
        return res.status(403).json({ error: '无权操作此任务' });
    }
    const ok = action === 'pause' ? progress.pauseTask(task.taskId)
        : action === 'resume' ? progress.resumeTask(task.taskId)
        : progress.requestCancel(task.taskId);
    if (!ok) return res.status(409).json({ error: '当前任务状态不允许此操作', status: task.status });
    res.json({ ok: true, status: task.status });
}
router.post('/task/:taskId/pause', authenticateToken, (req, res) => controlTask(req, res, 'pause'));
router.post('/task/:taskId/resume', authenticateToken, (req, res) => controlTask(req, res, 'resume'));
router.post('/task/:taskId/cancel', authenticateToken, (req, res) => controlTask(req, res, 'cancel'));

// 查询本客户端最近的任务（页面刷新后恢复进度面板）
router.get('/tasks', authenticateToken, (req, res) => {
    const clientId = req.query.clientId || `u${req.user?.id || 0}`;
    res.json({ tasks: progress.listByClient(clientId) });
});

// SSE 进度推送（EventSource 无法设置头，用 authSSE 支持 query token）
router.get('/progress', authSSE, (req, res) => {
    const clientId = req.query.clientId || `u${req.user?.id || 0}`;
    progress.addClient(clientId, res);
});

// 列出某目录下已下载的小说文件（默认 UPLOAD_DIR）
router.get('/local', authenticateToken, async (req, res) => {
    let dir;
    try {
        ({ dir } = await dirs.resolveManagedDir(getDb(), req.user, req.query.dir));
    } catch (e) {
        return res.status(e.statusCode || 400).json({ error: e.message });
    }
    const list = [];
    try {
        for (const f of fs.readdirSync(dir)) {
            if (/\.(epub|txt)$/i.test(f)) {
                const fp = path.join(dir, f);
                const st = fs.statSync(fp);
                list.push({
                    name: f,
                    size: st.size,
                    mtime: st.mtime,
                    ext: path.extname(f).slice(1).toLowerCase(),
                });
            }
        }
        list.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    } catch (e) {
        console.error('[NovelRoute] list local error:', e);
    }
    res.json({ dir, files: list });
});

// 下载已保存的小说文件（在浏览器中直接下载/另存）
router.get('/file/:name', authenticateToken, async (req, res) => {
    let dir;
    try {
        ({ dir } = await dirs.resolveManagedDir(getDb(), req.user, req.query.dir));
    } catch (e) {
        return res.status(e.statusCode || 400).json({ error: e.message });
    }
    const safe = path.basename(req.params.name);
    if (!/\.(epub|txt)$/i.test(safe)) return res.status(400).json({ error: '仅允许下载 epub/txt 文件' });
    const fp = path.join(dir, safe);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: '文件不存在' });
    res.download(fp, safe);
});

// 删除已下载的小说文件
router.delete('/file/:name', authenticateToken, async (req, res) => {
    let dir;
    try {
        ({ dir } = await dirs.resolveManagedDir(getDb(), req.user, req.query.dir));
    } catch (e) {
        return res.status(e.statusCode || 400).json({ error: e.message });
    }
    // 防路径穿越
    const safe = path.basename(req.params.name);
    if (!/\.(epub|txt)$/i.test(safe)) return res.status(400).json({ error: '仅允许删除 epub/txt 文件' });
    const fp = path.join(dir, safe);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: '文件不存在' });
    try {
        fs.unlinkSync(fp);
        // 同步移除书架记录（文件监听通常也会处理删除，这里兜底）
        try {
            const normDir = dir.replace(/\\/g, '/');
            const normFp = `${normDir}/${safe}`;
            getDb().run('DELETE FROM books WHERE REPLACE(filepath, ?, ?) = ?', ['\\', '/', normFp]);
        } catch (e) { console.warn('[NovelRoute] cleanup books record failed:', e.message); }
        res.json({ message: '已删除' });
    } catch (e) {
        res.status(500).json({ error: '删除失败: ' + e.message });
    }
});

// “打开下载文件夹”：Web 环境无法直接唤起宿主机文件管理器，
// 返回绝对路径供前端一键复制，并附带书库信息引导用户在书架中查看。
router.post('/open-dir', authenticateToken, async (req, res) => {
    try {
        const r = await dirs.resolveManagedDir(getDb(), req.user, req.body && req.body.dir);
        res.json({
            path: r.dir,
            libraryId: r.libraryId,
            libraryName: r.libraryName,
            hint: r.libraryName
                ? `该文件夹属于书库《${r.libraryName}》，下载的书会自动出现在书架中`
                : '已复制文件夹绝对路径，可在飞牛文件管理中粘贴打开',
        });
    } catch (e) {
        res.status(e.statusCode || 400).json({ error: e.message });
    }
});

module.exports = router;
