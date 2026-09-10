// 小说源规则加载器
// 加载 rules/ 目录下的 4 个规则文件，提供统一访问接口
// 规则格式兼容 go-novel (https://github.com/zsyo/go-novel) 的 JSON 规则

const fs = require('fs');
const path = require('path');

const RULES_DIR = path.join(__dirname, '..', 'rules');

let mainRules = [];
let flowlimitRules = [];
let nonSearchableRules = [];
let proxyRules = [];

// 限流规则按 sourceId 索引，便于查询某书源的爬取参数
let flowlimitMap = {};

// 需要代理的书源 ID 集合
let proxySourceIds = new Set();

// 不可搜索的书源列表（仅支持通过书籍 URL 直接下载）
let nonSearchableList = [];

function loadJson(file) {
    const p = path.join(RULES_DIR, file);
    if (!fs.existsSync(p)) return [];
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
        console.error('[NovelRules] Failed to parse', file, e.message);
        return [];
    }
}

function reload() {
    mainRules = loadJson('main-rules.json');
    flowlimitRules = loadJson('flowlimit-rules.json');
    nonSearchableRules = loadJson('non-searchable-rules.json');
    proxyRules = loadJson('proxy-rules.json');

    flowlimitMap = {};
    for (const r of flowlimitRules) {
        flowlimitMap[r.id] = r;
    }

    proxySourceIds = new Set(proxyRules.map(r => r.id));
    nonSearchableList = nonSearchableRules.slice();

    console.log(`[NovelRules] Loaded ${mainRules.length} main, ${flowlimitRules.length} flowlimit, ${nonSearchableRules.length} non-searchable, ${proxyRules.length} proxy rules`);
}

// 获取所有可搜索的书源（main + flowlimit + proxy，排除 disabled/needProxy 无代理时）
function getSearchableSources(includeProxy = false) {
    const list = [];
    for (const r of mainRules) {
        if (r.search && !r.search.disabled) list.push(r);
    }
    for (const r of flowlimitRules) {
        if (r.search && !r.search.disabled) list.push(r);
    }
    if (includeProxy) {
        for (const r of proxyRules) {
            if (r.search && !r.search.disabled) list.push(r);
        }
    }
    return list;
}

// 获取所有书源（含不可搜索的，用于通过 URL 下载）
function getAllSources() {
    return [...mainRules, ...flowlimitRules, ...nonSearchableRules, ...proxyRules];
}

// 按 ID 查找书源
function getSourceById(id) {
    id = Number(id);
    return getAllSources().find(r => r.id === id);
}

// 获取某书源的限流配置
function getCrawlConfig(sourceId) {
    const fl = flowlimitMap[sourceId];
    if (fl && fl.crawl) {
        return {
            threads: fl.crawl.threads || 4,
            minInterval: fl.crawl.minInterval || 200,
            maxInterval: fl.crawl.maxInterval || 400,
        };
    }
    return { threads: 4, minInterval: 200, maxInterval: 400 };
}

// 是否需要代理
function needsProxy(sourceId) {
    return proxySourceIds.has(Number(sourceId));
}

reload();

module.exports = {
    reload,
    getSearchableSources,
    getAllSources,
    getSourceById,
    getCrawlConfig,
    needsProxy,
    get nonSearchableSources() { return nonSearchableList; },
};
