// AI 听书（TTS）功能已恢复 — v0.1.2
// 纯 Express Router，支持 Edge 在线引擎（msedge-tts，npm 包已安装）+ 可选 sherpa-onnx 离线引擎。
// sherpa-onnx 因 arm64 原生模块未随仓库携带，构建脚本中仍可选装；本地开发可忽略。

const express = require('express');
const router = express.Router();
const path = require('path');

let ttsMgr = null;
try { ttsMgr = require('../utils/ttsManager'); } catch (e) { /* 会在首次调用时被 ttsManager 自己检测 */ }

// middleware: 确保 manager 已初始化
function ensureMgr(req, res, next) {
    if (!ttsMgr) {
        try { ttsMgr = require('../utils/ttsManager'); } catch (e) {
            return res.status(500).json({ error: 'TTS 管理器加载失败: ' + e.message });
        }
    }
    next();
}

// GET /status —— 前端会在阅读器挂载时探测 & 语音配置页渲染时调用
// bundle 期望返回：{ enabled, modelName, models: string[] }
// 注意 models 元素会被直接当作 React 子节点渲染，必须是字符串，否则触发 React error #31
router.use('/status', ensureMgr, async (req, res) => {
    try {
        const s = await ttsMgr.getStatus();
        res.json(s);
    } catch (e) {
        res.json({ enabled: false, available: false, modelName: null, models: [], engine: null, edge: false, local: false, error: e.message });
    }
});

// POST /generate —— 核心合成
// bundle 发送：{ text, speakerId, speed, engine: 'edge'|'local' }
// 返回：成功 = audio blob（content-type 由引擎决定，通常 audio/mpeg）；失败 = JSON error
router.post('/generate', ensureMgr, async (req, res) => {
    const { text, speakerId, speed, engine } = req.body || {};
    if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'text 为空' });
    }
    const engineUse = (engine === 'local' && ttsMgr.isLocalAvailable()) ? 'local' : 'edge';
    try {
        const audio = await ttsMgr.synthesize({ text: text.trim(), speakerId, speed, engine: engineUse });
        res.setHeader('Content-Type', audio.contentType || 'audio/mpeg');
        res.setHeader('Content-Length', audio.audio.length);
        res.end(audio.audio);
    } catch (e) {
        console.error('[tts] generate error:', e.message);
        res.status(500).json({ error: e.message || '合成失败' });
    }
});

// POST /model/load —— 加载 sherpa-onnx 离线模型
router.post('/model/load', ensureMgr, async (req, res) => {
    if (!ttsMgr.isLocalAvailable()) {
        return res.status(400).json({ error: '本地离线引擎未安装（sherpa-onnx-node 不可用）' });
    }
    try {
        const r = await ttsMgr.loadLocalModel(req.body || {});
        res.json({ success: true, ...r });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /model/unload
router.post('/model/unload', ensureMgr, async (req, res) => {
    if (!ttsMgr.isLocalAvailable()) return res.status(200).json({ success: true });
    try {
        await ttsMgr.unloadLocalModel();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// DELETE /model/:name —— 语音配置页「本地模型库」每一行都有删除按钮
// 本地引擎未集成时模型库恒为空，此接口仅作兜底，避免前端收到 404 HTML
router.delete('/model/:name', ensureMgr, async (req, res) => {
    if (!ttsMgr.isLocalAvailable()) {
        return res.status(400).json({ error: '本地离线引擎未安装，暂不支持模型管理' });
    }
    try {
        if (typeof ttsMgr.deleteLocalModel === 'function') {
            await ttsMgr.deleteLocalModel(req.params.name);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /upload —— 旧分享残留路由，已下线
router.post('/upload', (req, res) => res.status(410).json({ error: '本地模型上传已下线，请使用 Edge 在线引擎' }));

module.exports = router;
