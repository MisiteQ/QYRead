// 小说聚合搜索
// 并发调用多个书源搜索，聚合去重后返回

const rules = require('./novelRulesLoader');
const crawler = require('./novelCrawler');

// 聚合搜索
// keyword: 关键词
// options: { includeProxy, limitPerSource, timeoutMs }
async function aggregatedSearch(keyword, options = {}) {
    const { includeProxy = false, limitPerSource = 10, timeoutMs = 12000 } = options;
    const sources = rules.getSearchableSources(includeProxy);

    const tasks = sources.map(async (source) => {
        try {
            const results = await withTimeout(
                crawler.searchBySource(source, keyword, limitPerSource),
                timeoutMs
            );
            return results;
        } catch (e) {
            // 单源失败不影响整体
            console.warn(`[NovelSearch] Source ${source.name} (#${source.id}) failed:`, e.message);
            return [];
        }
    });

    const allResults = (await Promise.all(tasks)).flat();

    // 去重：按 bookName + author 合并多源命中
    const map = new Map();
    for (const r of allResults) {
        const key = `${(r.bookName || '').trim()}|${(r.author || '').trim()}`;
        if (!key) continue;
        if (map.has(key)) {
            map.get(key).sources.push({ sourceId: r.sourceId, sourceName: r.sourceName, bookUrl: r.bookUrl });
        } else {
            map.set(key, { ...r, sources: [{ sourceId: r.sourceId, sourceName: r.sourceName, bookUrl: r.bookUrl }] });
        }
    }

    return Array.from(map.values());
}

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('搜索超时')), ms)),
    ]);
}

module.exports = { aggregatedSearch };
