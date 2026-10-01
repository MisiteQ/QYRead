// 惬意阅读 - 扩展功能路由（明文，便于维护）
// 在线更新：/api/extra/update/*

const express = require('express');

const router = express.Router();

// 在线更新子路由（挂载到 /api/extra/update/*）
router.use('/update', require('./update'));

// 启动后台自动检查更新（延迟 30 秒等数据库/服务就绪）
try {
    const updater = require('../services/updater');
    setTimeout(() => { try { updater.startAutoCheck(); } catch (e) {} }, 30000);
} catch (e) {}

module.exports = router;
