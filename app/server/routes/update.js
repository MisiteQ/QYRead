// 惬意阅读 - 在线更新路由（明文，挂载到 /api/extra/update）
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const { authenticateToken, requireAdmin } = require('../middleware/auth');
const updater = require('../services/updater');

// 所有更新操作均需管理员鉴权
router.use(authenticateToken);
router.use(requireAdmin);

// 当前版本 / 最新版本 / 下载状态
router.get('/status', (req, res) => {
    res.json(updater.getStatus());
});

// 检查更新（force=true 跳过缓存）
router.post('/check', async (req, res) => {
    try {
        const info = await updater.check(true);
        res.json({
            current_version: info.current_version,
            latest_version: info.latest_version,
            has_update: info.has_update,
            notes: info.notes,
            asset: info.asset,
            error: info.error
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 下载安装包到 NAS
router.post('/download', async (req, res) => {
    try {
        // 优先用缓存（check 结果含 30 分钟缓存）；缓存无资产则强制刷新
        let info = await updater.check(false);
        let asset = info && info.asset;
        if (!asset) {
            info = await updater.check(true);
            asset = info && info.asset;
        }
        if (!asset) {
            return res.status(400).json({ error: '未找到匹配当前架构的安装包资产' });
        }
        const destDir = (req.body && req.body.dest_dir) || null;
        const r = await updater.downloadToNas(asset, destDir);
        if (r.success) {
            res.json({ success: true, downloaded: true, path: r.path });
        } else {
            res.status(500).json({ error: r.error });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 安装并重启
router.post('/install', async (req, res) => {
    try {
        let fpkPath = (req.body && req.body.path) || updater.downloadedPath();
        if (!fpkPath || !fs.existsSync(fpkPath)) {
            return res.status(400).json({ error: '请先下载安装包' });
        }
        const r = await updater.installPackage(fpkPath);
        if (r.success) {
            // 先回响应，再重启
            res.json({ success: true, message: r.message });
            setTimeout(() => { try { updater.restart(); } catch (e) {} }, 300);
        } else {
            res.status(500).json({ error: r.error });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 浏览器代理下载（流式返回 fpk）
router.get('/asset', (req, res) => {
    const fpkPath = updater.downloadedPath();
    if (!fpkPath || !fs.existsSync(fpkPath)) {
        return res.status(404).json({ error: '本地未下载安装包' });
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="' + path.basename(fpkPath) + '"');
    fs.createReadStream(fpkPath).pipe(res);
});

// 配置读写
router.get('/config', (req, res) => {
    res.json(updater.loadConfig());
});
router.post('/config', (req, res) => {
    try {
        const old = updater.loadConfig();
        const cfg = {
            autocheck: req.body.autocheck !== undefined ? !!req.body.autocheck : old.autocheck,
            autoupdate: req.body.autoupdate !== undefined ? !!req.body.autoupdate : old.autoupdate
        };
        updater.saveConfig(cfg);
        res.json({ success: true, config: cfg });
        // 从「关」切到「开」：立即在后台执行一次 检查→下载→安装→重启，
        // 不必让用户干等下一个 6 小时间隔（内部有并发保护与同版本包复用）。
        if (cfg.autoupdate && !old.autoupdate) {
            setTimeout(() => {
                try { updater.runAutoUpdate(); } catch (e) {}
            }, 1000);
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
