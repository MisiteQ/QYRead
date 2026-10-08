// 惬意阅读 - 书籍封面/作者自动补全服务（明文，便于维护）
// 策略：内嵌封面优先（复用 utils/coverExtractor），无内嵌则用书源聚合搜索联网补全
// 只填空缺字段（cover 为空、author 为「佚名/未知」等占位值视为缺失），绝不覆盖已有数据

const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');
const { dbRun, dbGet, dbAll } = require('../db');
const { isMetadataMissing } = require('./bookMetadataAi');
const { aggregatedSearch } = require('./novelSearcher');
const crawler = require('./novelCrawler');
const rules = require('./novelRulesLoader');
const coverExtractor = require('../utils/coverExtractor');

// 与 coverExtractor.js 保持一致的图片目录
const IMAGES_DIR = process.env.IMAGES_DIR || path.join(__dirname, '..', 'images');
const SEARCH_TIMEOUT_MS = 15000;
const DOWNLOAD_TIMEOUT_MS = 15000;
const MAX_COVER_BYTES = 5 * 1024 * 1024;
const BATCH_CONCURRENCY = 3;
const BATCH_LIMIT = 20; // 单次调用最多处理的本数，前端可再次调用续补
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// 同一本书的在途请求去重
const inflight = new Map();

/* ===================== 标题/搜索词 ===================== */

const EXT_RE = /\.(epub|txt|mobi|azw3|azw|prc|pdf|fb2|cbz|cbr|cb7|md)$/i;

function stripExt(t) {
    return String(t || '').replace(EXT_RE, '').trim();
}

// 归一化：去扩展名/书名号/括号/空白，小写——用于书名严格比对
function normalizeTitle(t) {
    return String(t || '')
        .replace(EXT_RE, '')
        .replace(/[《》【】〔〕（）()\[\]「」\s·、，,.。:：;；!！?？~～\-—_]/g, '')
        .toLowerCase();
}

// 构造搜索词：优先剥掉括号后缀（如「旧神之颜（盲）」→「旧神之颜」），全词作备选
function buildQueries(title) {
    const main = stripExt(title);
    if (!main) return [];
    const queries = [];
    const cleaned = main.replace(/[（(【\[][^（）()【】\[\]]*[）)】\]]/g, '').trim();
    if (cleaned && cleaned !== main && cleaned.length >= 2) queries.push(cleaned);
    queries.push(main);
    return queries;
}

/* ===================== TXT 文件头作者提取（辅助过滤，失败不影响流程） ===================== */

function decodeHead(buf) {
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return iconv.decode(buf, 'utf16le');
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return iconv.decode(buf, 'utf16be');
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return iconv.decode(buf, 'utf8');
    const utf8 = iconv.decode(buf, 'utf8');
    // 乱码（替换字符）过多则按 GBK 重试
    const bad = (utf8.match(/\ufffd/g) || []).length;
    if (bad > 0 && bad / Math.max(1, utf8.length) > 0.02) return iconv.decode(buf, 'gbk');
    return utf8;
}

function extractAuthorFromFile(filepath) {
    try {
        const fd = fs.openSync(filepath, 'r');
        const buf = Buffer.alloc(8192);
        let bytes = 0;
        try {
            bytes = fs.readSync(fd, buf, 0, buf.length, 0);
        } finally {
            fs.closeSync(fd);
        }
        if (!bytes) return '';
        const head = decodeHead(buf.slice(0, bytes));
        const patterns = [
            /作\s*者[：:]\s*([^\s，。,、；;：:"'「」]{1,30})/,
            /^\s*(?:本文)?作者[：:]\s*([^\s，。,、；;：:"'「」]{1,30})/m,
            /^\s*by[:：]?\s*([^\s，。,、]{1,30})/im,
        ];
        for (const re of patterns) {
            const m = head.match(re);
            if (m && m[1]) {
                const author = m[1].trim();
                if (author && !isMetadataMissing(author)) return author;
            }
        }
    } catch (e) { /* 提取失败不影响主流程 */ }
    return '';
}

/* ===================== 封面图片下载 ===================== */

function looksLikeImage(buf) {
    if (buf.length < 12) return false;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // jpeg
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // png
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true; // gif
    if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return true;
    if (buf[0] === 0x42 && buf[1] === 0x4d) return true; // bmp
    return false;
}

function extFromType(type, buf) {
    const t = String(type || '').toLowerCase();
    if (t.includes('png')) return '.png';
    if (t.includes('gif')) return '.gif';
    if (t.includes('webp')) return '.webp';
    if (t.includes('bmp')) return '.bmp';
    if (t.includes('jpeg') || t.includes('jpg')) return '.jpg';
    // Content-Type 缺失时按魔数猜
    if (buf[0] === 0x89 && buf[1] === 0x50) return '.png';
    if (buf[0] === 0x47 && buf[1] === 0x49) return '.gif';
    return '.jpg';
}

async function fetchWithTimeout(url, headers) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
        return await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
    } finally {
        clearTimeout(timer);
    }
}

// 下载封面：先带 Referer（防盗链），失败降级为无 Referer
async function downloadCoverImage(url, referer) {
    const attempts = [];
    if (referer) attempts.push({ 'User-Agent': UA, Referer: referer, Accept: 'image/*,*/*;q=0.8' });
    attempts.push({ 'User-Agent': UA, Accept: 'image/*,*/*;q=0.8' });
    for (const headers of attempts) {
        try {
            const resp = await fetchWithTimeout(url, headers);
            if (!resp.ok) continue;
            const type = resp.headers.get('content-type') || '';
            if (type && !type.toLowerCase().startsWith('image/')) continue;
            const buf = Buffer.from(await resp.arrayBuffer());
            if (!buf.length || buf.length > MAX_COVER_BYTES) continue;
            if (!looksLikeImage(buf)) continue;
            return { buf, ext: extFromType(type, buf) };
        } catch (e) { /* 尝试下一组请求头 */ }
    }
    return null;
}

function refererOf(url) {
    try {
        const u = new URL(url);
        return u.origin + '/';
    } catch (e) {
        return '';
    }
}

/* ===================== 匹配与补全 ===================== */

// 严格匹配：书名归一化后与搜索词完全相等才采纳（宁缺毋滥，避免张冠李戴）
function pickMatch(candidates, query) {
    const nq = normalizeTitle(query);
    if (!nq) return null;
    for (const c of candidates || []) {
        if (!c || !c.bookName || !c.bookUrl) continue;
        if (normalizeTitle(c.bookName) === nq) return c;
    }
    return null;
}

async function fetchBookDetail(match) {
    const source = rules.getSourceById(match.sourceId);
    if (!source || !match.bookUrl) return null;
    try {
        const { info } = await crawler.fetchBookInfo(source, match.bookUrl);
        return info || null;
    } catch (e) {
        return null;
    }
}

async function _enrichBook(bookId) {
    const book = await dbGet(
        'SELECT id, title, filepath, format, cover, author FROM books WHERE id = ?',
        [bookId]
    );
    if (!book) return { bookId, ok: false, reason: 'not_found' };

    const result = { bookId, ok: true, cover_added: false, author_added: false, skipped: false };
    const coverMissing = !book.cover;
    const authorMissing = isMetadataMissing(book.author);
    if (!coverMissing && !authorMissing) {
        result.skipped = true;
        return result;
    }

    // 1) 内嵌封面兜底（epub/mobi/azw3/cbz/cbr/cb7；模块内部幂等，已有封面文件时短路返回）
    let coverMissingNow = coverMissing;
    if (coverMissing && book.filepath && fs.existsSync(book.filepath)) {
        try {
            const coverPath = await coverExtractor.extractCover(
                book.filepath, String(book.format || ''), book.id
            );
            if (coverPath) {
                await dbRun('UPDATE books SET cover = ? WHERE id = ?', [coverPath, book.id]);
                result.cover_added = true;
                coverMissingNow = false;
            }
        } catch (e) { /* 转网络搜索兜底 */ }
    }

    // 2) 联网补全（封面仍缺 或 作者缺失时才需要）
    const authorMissingNow = authorMissing;
    if (!coverMissingNow && !authorMissingNow) return result;

    const fileAuthor = /\.(txt|md)$/i.test(String(book.format || book.title || ''))
        ? extractAuthorFromFile(book.filepath)
        : '';

    const queries = buildQueries(book.title);
    let match = null;
    for (const q of queries) {
        if (!q || q.length < 2) continue;
        let candidates = [];
        try {
            candidates = await aggregatedSearch(q, { timeoutMs: SEARCH_TIMEOUT_MS });
        } catch (e) { /* 单次搜索失败继续下一个备选词 */ }
        match = pickMatch(candidates, q);
        if (match) break;
    }

    if (!match) {
        result.no_match = true;
        return result;
    }

    // 搜索结果不含封面 URL，需要取详情页（同时拿更完整的作者字段）
    const info = await fetchBookDetail(match);

    // 2a) 写作者：仅在缺失时，绝不覆盖
    if (authorMissingNow) {
        const author = String((info && info.author) || match.author || fileAuthor || '').trim();
        if (author && !isMetadataMissing(author) && author.length <= 50) {
            await dbRun('UPDATE books SET author = ? WHERE id = ?', [author, book.id]);
            result.author_added = true;
        }
    }

    // 2b) 下载封面
    const coverUrl = info && info.coverUrl;
    if (coverMissingNow && coverUrl) {
        const dl = await downloadCoverImage(coverUrl, refererOf(match.bookUrl));
        if (dl) {
            const file = 'cover_' + book.id + dl.ext;
            const dest = path.join(IMAGES_DIR, file);
            try {
                fs.mkdirSync(IMAGES_DIR, { recursive: true });
                await fs.promises.writeFile(dest, dl.buf);
                await dbRun('UPDATE books SET cover = ? WHERE id = ?', ['/images/' + file, book.id]);
                result.cover_added = true;
            } catch (e) { /* 落盘失败保持占位 */ }
        }
    }

    return result;
}

// 对外入口：同一本书并发调用只执行一次
function enrichBook(bookId) {
    const id = Number(bookId);
    if (!Number.isInteger(id) || id <= 0) {
        return Promise.resolve({ bookId: id, ok: false, reason: 'invalid_id' });
    }
    if (inflight.has(id)) return inflight.get(id);
    const p = _enrichBook(id).finally(() => inflight.delete(id));
    inflight.set(id, p);
    return p;
}

// 查找缺封面或缺作者（含「佚名/未知」占位）的书
async function findMissingBookIds() {
    const rows = await dbAll('SELECT id, title, cover, author FROM books');
    return (rows || [])
        .filter(r => !r.cover || isMetadataMissing(r.author))
        .map(r => r.id);
}

// 批量补全：并发 3，单次上限 limit 本（前端可循环续补）
async function enrichMissingBooks(ids = null, limit = BATCH_LIMIT) {
    let targetIds;
    if (Array.isArray(ids) && ids.length) {
        targetIds = ids.map(Number).filter(n => Number.isInteger(n) && n > 0);
    } else {
        targetIds = await findMissingBookIds();
    }

    const queue = targetIds.slice(0, Math.max(1, Math.min(Number(limit) || BATCH_LIMIT, 50)));
    const results = [];
    let processed = 0, covers = 0, authors = 0;

    const worker = async () => {
        while (queue.length) {
            const id = queue.shift();
            if (id == null) break;
            try {
                const r = await enrichBook(id);
                results.push(r);
                if (r.ok) {
                    // skipped（不缺字段）也计入 processed，保证 remaining 统计准确
                    processed++;
                    if (r.cover_added) covers++;
                    if (r.author_added) authors++;
                }
            } catch (e) {
                results.push({ bookId: id, ok: false, reason: e.message });
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, queue.length) }, worker));

    return {
        total_missing: targetIds.length,
        processed,
        covers_added: covers,
        authors_added: authors,
        remaining: Math.max(0, targetIds.length - processed),
        results,
    };
}

module.exports = {
    enrichBook,
    enrichMissingBooks,
    findMissingBookIds,
    buildQueries,
    normalizeTitle,
};
