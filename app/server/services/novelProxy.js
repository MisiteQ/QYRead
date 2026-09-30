// 小说下载代理配置服务
// 持久化代理设置到 data 目录下的 novel-proxy.json，并在抓取时按需构造代理 Agent。
// 仅影响小说搜索/下载链路（novelCrawler.fetchHtml），不影响主站其他请求。

const fs = require('fs');
const path = require('path');
const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

const DATA_DIR = process.env.TRIM_PKGVAR || process.env.DATA_DIR || path.join(__dirname, '..');
const CONFIG_FILE = path.join(DATA_DIR, 'novel-proxy.json');

// 内存缓存，避免每次请求都读盘
let cache = null;

function defaultConfig() {
    return { enabled: false, url: '' };
}

function load() {
    if (cache) return cache;
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            cache = {
                enabled: !!raw.enabled,
                url: typeof raw.url === 'string' ? raw.url.trim() : '',
            };
        } else {
            cache = defaultConfig();
        }
    } catch (e) {
        console.warn('[NovelProxy] 读取代理配置失败，使用默认值:', e.message);
        cache = defaultConfig();
    }
    return cache;
}

function save(cfg) {
    const next = {
        enabled: !!cfg.enabled,
        url: typeof cfg.url === 'string' ? cfg.url.trim() : '',
    };
    cache = next;
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
    } catch (e) {
        console.warn('[NovelProxy] 保存代理配置失败:', e.message);
        throw new Error('保存代理配置失败: ' + e.message);
    }
    return next;
}

function getConfig() {
    return load();
}

function setConfig(cfg) {
    return save(cfg || {});
}

// 当前是否启用了代理
function isEnabled() {
    const c = load();
    return c.enabled && !!c.url;
}

// 根据目标 URL 协议返回对应的代理 Agent（供 http/https 模块使用）
// targetProtocol: 'http:' | 'https:'
function getAgent(targetProtocol) {
    const c = load();
    if (!c.enabled || !c.url) return null;
    try {
        // http-proxy-agent / https-proxy-agent 均支持 http:// 与 https:// 代理地址
        if (targetProtocol === 'http:') {
            return new HttpProxyAgent(c.url);
        }
        return new HttpsProxyAgent(c.url);
    } catch (e) {
        console.warn('[NovelProxy] 创建代理 Agent 失败:', e.message);
        return null;
    }
}

module.exports = {
    getConfig,
    setConfig,
    isEnabled,
    getAgent,
};
