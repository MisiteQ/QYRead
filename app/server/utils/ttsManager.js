// AI 听书 TTS 管理器 —— Edge 在线引擎（msedge-tts v2）+ sherpa-onnx 可选离线
// msedge-tts v2 API：setMetadata(voice, format) → toStream(text) → readable stream → 收集 Buffer
// 混淆 server.js 启动时会 require 并调用 initTTS()，请保持默认导出接口稳定

let _edge = null;
let _edgeReady = false;
let _initPromise = null;

// msedge-tts OUTPUT_FORMAT 常量（MPEG MP3）
const MP3_FMT = 'audio-24khz-48kbitrate-mono-mp3';

function msedgeAvailable() {
    try {
        if (!_edge) {
            const { MsEdgeTTS } = require('msedge-tts');
            _edge = new MsEdgeTTS();
        }
        return !!_edge;
    } catch (e) {
        _edge = null;
        return false;
    }
}
function sherpaAvailable() {
    try { require('sherpa-onnx-node'); return true; }
    catch { return false; }
}

// 把 Node Readable stream 完整收集成 Buffer
function streamToBuffer(readable) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        readable.on('data', c => chunks.push(c));
        readable.on('end', () => resolve(Buffer.concat(chunks)));
        readable.on('error', reject);
    });
}

async function initTTS() {
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
        if (!msedgeAvailable()) {
            return { available: false, edge: false, local: sherpaAvailable() };
        }
        try {
            const voices = await _edge.getVoices();
            _edgeReady = Array.isArray(voices) && voices.length > 0;
        } catch (e) {
            // 冷启动时可能因网络/UA 被拒，generate 时再报
            _edgeReady = false;
        }
        return { available: _edgeReady || sherpaAvailable(), edge: _edgeReady, local: sherpaAvailable() };
    })().catch(e => { _initPromise = null; throw e; });
    return _initPromise;
}

function isAvailable() { return _edgeReady || sherpaAvailable(); }
function isEdgeAvailable() { return _edgeReady; }
function isLocalAvailable() { return sherpaAvailable(); }

function getStatus() {
    // 注意：前端「语音配置」页对 models 的渲染是 <div>{model}</div>，
    // 必须是「本地模型名称字符串」数组；返回对象数组会触发 React error #31（页面崩溃）。
    // 在线 Edge 引擎不出现在这里（它有独立的 tab，无需挂载/卸载模型）。
    const models = [];
    const localOn = sherpaAvailable();
    return {
        enabled: localOn,            // 本地引擎是否已挂载（本地 tab 的状态灯读这个字段）
        available: isAvailable(),
        modelName: null,             // 当前挂载的本地模型名（未集成 sherpa 时恒为 null）
        models,                      // 本地模型库：字符串数组，未集成时为空
        engine: _edgeReady ? 'edge' : (localOn ? 'local' : null),
        edge: _edgeReady,
        edgeAvailable: _edgeReady,
        local: localOn,
    };
}

// 合成音频：{ text, speakerId, speed, engine } → { audio: Buffer, contentType }
async function synthesize({ text, speakerId, speed, engine }) {
    if (!_edge) msedgeAvailable();
    if (!_edge) throw new Error('Edge TTS 加载失败，请确认 msedge-tts 依赖已安装');

    const voice = speakerId || 'zh-CN-XiaoxiaoNeural';
    try {
        // 1) 设置语音和输出格式（每次 toStream 前必须 setMetadata，否则沿用上次的）
        await _edge.setMetadata(voice, MP3_FMT);
        // 2) 流式合成
        const { audioStream } = _edge.toStream(text);
        const audio = await streamToBuffer(audioStream);
        return { audio, contentType: 'audio/mpeg' };
    } catch (e) {
        // 常见错误：401 Unauthorized / Agent 被拒 / 网络不可达
        throw new Error('Edge TTS 合成失败: ' + (e.message || String(e)).slice(0, 120));
    }
}

async function loadLocalModel() { throw new Error('本地离线引擎暂未集成'); }
async function unloadLocalModel() { _edge && _edge.close && _edge.close(); }
async function reloadTTS() { _initPromise = null; _edgeReady = false; return initTTS(); }
async function unloadTTS() { _edge && _edge.close && _edge.close(); return true; }

module.exports = {
    initTTS, isAvailable, isEdgeAvailable, isLocalAvailable, getStatus,
    synthesize, loadLocalModel, unloadLocalModel, reloadTTS, unloadTTS,
};
