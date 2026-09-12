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

/* ===================== 书源增删改查（管理用） =====================
 * 4 个规则文件按 category 区分（同一文件内 id 独立，跨文件可能重复，故 CRUD 用 category+id 复合键）
 * category ∈ { main, flowlimit, non-searchable, proxy }
 */
const CATEGORY_META = [
    { key: 'main', file: 'main-rules.json', arr: () => mainRules },
    { key: 'flowlimit', file: 'flowlimit-rules.json', arr: () => flowlimitRules },
    { key: 'non-searchable', file: 'non-searchable-rules.json', arr: () => nonSearchableRules },
    { key: 'proxy', file: 'proxy-rules.json', arr: () => proxyRules },
];

function getCategoryArray(category) {
    const meta = CATEGORY_META.find(m => m.key === category);
    return meta ? meta.arr() : null;
}
function getCategoryFile(category) {
    const meta = CATEGORY_META.find(m => m.key === category);
    return meta ? meta.file : null;
}

// 重建派生索引（增删改后调用，保证搜索/下载立即生效）
function rebuildIndexes() {
    flowlimitMap = {};
    for (const r of flowlimitRules) flowlimitMap[r.id] = r;
    proxySourceIds = new Set(proxyRules.map(r => r.id));
    nonSearchableList = nonSearchableRules.slice();
}

// 列出所有书源（带 category，供管理 UI）
function listAllWithCategory() {
    const out = [];
    for (const m of CATEGORY_META) {
        for (const r of m.arr()) out.push(Object.assign({}, r, { category: m.key }));
    }
    return out;
}

// 按 category + id 获取完整规则（带 category）
function getSourceDetail(category, id) {
    const arr = getCategoryArray(category);
    if (!arr) return null;
    id = Number(id);
    const r = arr.find(s => s.id === id);
    return r ? Object.assign({}, r, { category }) : null;
}

// 计算某分类下的下一个可用 id
function nextId(category) {
    const arr = getCategoryArray(category);
    if (!arr || !arr.length) return 1;
    return Math.max.apply(null, arr.map(s => Number(s.id) || 0)) + 1;
}

// 将某分类的数组写回磁盘
function saveCategory(category) {
    const file = getCategoryFile(category);
    const arr = getCategoryArray(category);
    if (!file || !arr) throw new Error('无效的书源分类: ' + category);
    const p = path.join(RULES_DIR, file);
    fs.writeFileSync(p, JSON.stringify(arr, null, 2), 'utf8');
}

// 新增书源；rule 为 go-novel 格式的规则对象（不含 id，由系统分配）
function addSource(category, rule) {
    const arr = getCategoryArray(category);
    if (!arr) throw new Error('无效的书源分类: ' + category);
    if (!rule || typeof rule !== 'object') throw new Error('规则必须为对象');
    const id = nextId(category);
    const newRule = Object.assign({}, rule, { id });
    arr.push(newRule);
    saveCategory(category);
    rebuildIndexes();
    return Object.assign({}, newRule, { category });
}

// 更新书源；newCategory 可选，跨分类移动时会在目标分类重新分配 id
function updateSource(category, id, newRule, newCategory) {
    const arr = getCategoryArray(category);
    if (!arr) throw new Error('无效的书源分类: ' + category);
    id = Number(id);
    const idx = arr.findIndex(s => s.id === id);
    if (idx === -1) throw new Error('书源不存在');
    if (!newRule || typeof newRule !== 'object') throw new Error('规则必须为对象');
    const targetCat = newCategory || category;
    if (!getCategoryArray(targetCat)) throw new Error('无效的目标分类: ' + targetCat);
    if (targetCat === category) {
        // 同分类更新：保留原 id
        arr[idx] = Object.assign({}, newRule, { id });
        saveCategory(category);
    } else {
        // 跨分类移动：从旧分类删除，在目标分类追加（重新分配 id）
        arr.splice(idx, 1);
        saveCategory(category);
        const newArr = getCategoryArray(targetCat);
        const newId = nextId(targetCat);
        newArr.push(Object.assign({}, newRule, { id: newId }));
        saveCategory(targetCat);
        rebuildIndexes();
        return Object.assign({}, newRule, { id: newId, category: targetCat });
    }
    rebuildIndexes();
    return Object.assign({}, arr[idx], { category });
}

// 删除书源
function deleteSource(category, id) {
    const arr = getCategoryArray(category);
    if (!arr) throw new Error('无效的书源分类: ' + category);
    id = Number(id);
    const idx = arr.findIndex(s => s.id === id);
    if (idx === -1) throw new Error('书源不存在');
    arr.splice(idx, 1);
    saveCategory(category);
    rebuildIndexes();
    return true;
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
    listAllWithCategory,
    getSourceDetail,
    addSource,
    updateSource,
    deleteSource,
};
