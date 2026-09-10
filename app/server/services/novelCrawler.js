// 小说爬虫核心
// 基于 go-novel 规则 JSON 的 CSS 选择器 + jsdom（已安装依赖）实现
// 处理：搜索 / 书籍详情 / 目录 / 章节正文

const { JSDOM } = require('jsdom');
const iconv = require('iconv-lite');
const { URL } = require('url');

// 带编码探测的 HTTP GET
async function fetchHtml(url, options = {}) {
    const { method = 'GET', data = null, cookies = '', timeout = 15000, signal: externalSignal = null } = options;
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    };
    if (cookies) headers['Cookie'] = cookies;

    let finalUrl = url;
    let body = data;
    if (data && method.toUpperCase() === 'POST') {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = data.replace(/[{}]/g, '').split(',').map(pair => {
            const idx = pair.indexOf(':');
            if (idx === -1) return '';
            const k = pair.slice(0, idx).trim();
            const v = pair.slice(idx + 1).trim();
            return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
        }).filter(Boolean).join('&');
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    // 外部取消信号（用户取消任务）联动中断本次请求
    const onExternalAbort = () => ctrl.abort();
    if (externalSignal) {
        if (externalSignal.aborted) ctrl.abort();
        else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
        const res = await fetch(finalUrl, {
            method: method.toUpperCase(),
            headers,
            body: method.toUpperCase() === 'POST' ? body : undefined,
            signal: ctrl.signal,
            redirect: 'follow',
        });
        clearTimeout(timer);
        if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
        finalUrl = res.url || finalUrl;

        const buf = Buffer.from(await res.arrayBuffer());
        let html = decodeBuffer(buf, res.headers.get('content-type') || '');
        return { html, finalUrl };
    } catch (e) {
        clearTimeout(timer);
        if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
        throw new Error(`请求失败 ${url}: ${e.message}`);
    }
}

// 从 Content-Type 和 meta 探测编码，解码为字符串
function decodeBuffer(buf, contentType) {
    let charset = '';
    if (contentType) {
        const m = contentType.match(/charset=([^\s;]+)/i);
        if (m) charset = m[1];
    }
    if (!charset) {
        const head = buf.slice(0, 2048).toString('latin1');
        const m = head.match(/charset=["']?([\w-]+)/i);
        if (m) charset = m[1];
    }
    charset = (charset || 'utf-8').toLowerCase();
    if (charset === 'gb2312' || charset === 'gbk' || charset === 'gb18030') {
        return iconv.decode(buf, 'gb18030');
    }
    return buf.toString(charset);
}

// 执行规则中 @js: 后缀的后处理代码
function applyJsPostProcess(value, jsCode) {
    if (!jsCode) return value;
    try {
        // eslint-disable-next-line no-new-func
        const fn = new Function('r', jsCode);
        return fn(value) || value;
    } catch (e) {
        console.warn('[NovelCrawler] @js post-process failed:', jsCode.slice(0, 80), e.message);
        return value;
    }
}

// 拆分 "selector@js:code" → { selector, js }
function parseSelector(spec) {
    if (!spec) return { selector: '', js: '' };
    const idx = spec.indexOf('@js:');
    if (idx === -1) return { selector: spec, js: '' };
    return { selector: spec.slice(0, idx), js: spec.slice(idx + 4) };
}

// 从 DOM 元素提取属性或文本
function extractFromNode(el, spec, attrHint = null) {
    const { selector, js } = parseSelector(spec);
    if (!selector) return applyJsPostProcess('', js);

    let node = el;
    if (selector) {
        node = el.querySelector(selector);
        if (!node) return '';
    }
    let val;
    // meta[property=...] 取 content
    if (node.tagName === 'META') {
        val = node.getAttribute('content') || '';
    } else if (attrHint === 'href' || selector.includes(' a') || selector.endsWith('>a') || selector === 'a') {
        val = node.getAttribute('href') || node.textContent || '';
    } else {
        val = node.getAttribute('content') || node.textContent || node.getAttribute('href') || '';
    }
    val = (val || '').trim();
    return applyJsPostProcess(val, js);
}

// 聚合搜索：在单个书源搜索
async function searchBySource(source, keyword, limit = 10) {
    const s = source.search;
    if (!s || s.disabled) return [];

    let url = s.url;
    let method = (s.method || 'GET').toUpperCase();
    let data = s.data || '';

    if (url.includes('%s')) {
        url = url.replace('%s', encodeURIComponent(keyword));
    }
    if (data.includes('%s')) {
        data = data.replace('%s', keyword);
    }

    const results = [];
    let pageUrl = url;
    let pages = 0;
    const maxPages = s.pagination ? 3 : 1;

    while (pageUrl && pages < maxPages) {
        const { html, finalUrl } = await fetchHtml(pageUrl, { method, data: pages === 0 ? data : null, cookies: s.cookies });
        const dom = new JSDOM(html, { url: finalUrl });
        const doc = dom.window.document;

        const items = doc.querySelectorAll(s.result);
        for (const el of items) {
            const name = extractFromNode(el, s.bookName);
            if (!name) continue;
            // 书 URL 从 bookName 选择器取 href
            const bookUrl = extractFromNode(el, s.bookName, 'href');
            results.push({
                sourceId: source.id,
                sourceName: source.name,
                bookName: name,
                author: extractFromNode(el, s.author),
                category: extractFromNode(el, s.category),
                latestChapter: extractFromNode(el, s.latestChapter),
                lastUpdateTime: extractFromNode(el, s.lastUpdateTime),
                wordCount: extractFromNode(el, s.wordCount),
                status: extractFromNode(el, s.status),
                intro: extractFromNode(el, s.intro),
                bookUrl: bookUrl || '',
            });
            if (results.length >= limit) break;
        }

        // 翻页
        if (s.pagination && s.nextPage && results.length < limit) {
            const nextEl = doc.querySelector(s.nextPage);
            if (nextEl) {
                const nextHref = nextEl.getAttribute('href') || nextEl.value || '';
                if (nextHref) {
                    pageUrl = resolveUrl(nextHref, finalUrl);
                    pages++;
                    continue;
                }
            }
            break;
        } else break;
    }

    return results;
}

// 解析相对 URL 为绝对 URL
function resolveUrl(href, base) {
    if (!href) return '';
    if (href.startsWith('http')) return href;
    if (href.startsWith('//')) return 'http:' + href;
    try {
        return new URL(href, base).href;
    } catch {
        return href;
    }
}

// 获取书籍详情
async function fetchBookInfo(source, bookUrl, signal = null) {
    const { html, finalUrl } = await fetchHtml(bookUrl, { cookies: source.search?.cookies, signal });
    const dom = new JSDOM(html, { url: finalUrl });
    const doc = dom.window.document;
    const b = source.book || {};

    const info = {
        sourceId: source.id,
        sourceName: source.name,
        bookUrl,
        bookName: extractFromNode(doc, b.bookName),
        author: extractFromNode(doc, b.author),
        intro: extractFromNode(doc, b.intro),
        category: extractFromNode(doc, b.category),
        coverUrl: extractFromNode(doc, b.coverUrl),
        latestChapter: extractFromNode(doc, b.latestChapter),
        lastUpdateTime: extractFromNode(doc, b.lastUpdateTime),
        status: extractFromNode(doc, b.status),
        wordCount: extractFromNode(doc, b.wordCount),
    };
    if (info.coverUrl) info.coverUrl = resolveUrl(info.coverUrl, finalUrl);
    return { info, doc, finalUrl };
}

// 获取目录
async function fetchToc(source, bookInfo, bookDoc, bookUrl, signal = null) {
    const toc = source.toc || {};
    let tocUrl = bookUrl;

    // 某些源目录页和书籍页不同
    if (toc.url) {
        const bookIdMatch = (source.book?.url || '').match(/\((.*?)\)/);
        if (bookIdMatch) {
            const re = new RegExp(bookIdMatch[1]);
            const m = bookUrl.match(re);
            if (m && m[1]) tocUrl = toc.url.replace('%s', m[1]);
        }
    } else if (toc.baseUri) {
        const bookIdMatch = (source.book?.url || '').match(/\((.*?)\)/);
        if (bookIdMatch) {
            const re = new RegExp(bookIdMatch[1]);
            const m = bookUrl.match(re);
            if (m && m[1]) tocUrl = toc.baseUri.replace('%s', m[1]);
        }
    }

    const chapters = [];
    let pages = 0;
    const maxPages = toc.pagination ? 20 : 1;
    let currentUrl = tocUrl;
    let doc = bookDoc;

    while (currentUrl && pages < maxPages) {
        if (pages > 0 || toc.url || toc.baseUri) {
            const { html, finalUrl } = await fetchHtml(currentUrl, { signal });
            const dom = new JSDOM(html, { url: finalUrl });
            doc = dom.window.document;
        }

        const items = doc.querySelectorAll(toc.item);
        for (const el of items) {
            const title = (el.textContent || '').trim();
            const href = el.getAttribute('href');
            if (title && href) {
                chapters.push({ title, url: resolveUrl(href, currentUrl) });
            }
        }

        if (toc.pagination && toc.nextPage) {
            const nextEl = doc.querySelector(toc.nextPage);
            if (nextEl) {
                const nextHref = nextEl.getAttribute('href') || nextEl.value || '';
                if (nextHref) {
                    currentUrl = resolveUrl(String(nextHref), currentUrl);
                    pages++;
                    continue;
                }
            }
            break;
        } else break;
    }

    return chapters;
}

// 获取章节正文
async function fetchChapter(source, chapter, chapterConfig, signal = null) {
    const c = chapterConfig || source.chapter || {};
    let url = chapter.url;
    let content = '';
    let title = chapter.title || '';
    let pages = 0;
    const maxPages = c.pagination ? 5 : 1;

    while (url && pages < maxPages) {
        const { html, finalUrl } = await fetchHtml(url, { signal });
        const dom = new JSDOM(html, { url: finalUrl });
        const doc = dom.window.document;

        if (!title || pages === 0) {
            const t = extractFromNode(doc, c.title);
            if (t) title = t;
        }

        // 提取正文
        const { selector, js } = parseSelector(c.content);
        if (selector) {
            let node = doc.querySelector(selector);
            if (node) {
                // 清理 filterTag 标签
                if (c.filterTag) {
                    const tags = c.filterTag.split(/\s+/).filter(Boolean);
                    for (const tag of tags) {
                        const remove = node.querySelectorAll(tag);
                        remove.forEach(n => n.remove());
                    }
                }
                let raw = node.innerHTML || node.textContent || '';
                if (js) raw = applyJsPostProcess(raw, js);
                content += cleanChapterContent(raw, c);
            }
        }

        // 翻页（同一章节分页）
        if (c.pagination && c.nextPage) {
            const nextEl = doc.querySelector(c.nextPage);
            if (nextEl) {
                const nextHref = nextEl.getAttribute('href');
                const nextUrl = nextHref ? resolveUrl(nextHref, finalUrl) : '';
                // 避免跳到下一章（检查 nextChapterLink）
                if (nextUrl && (!c.nextChapterLink || !new RegExp(c.nextChapterLink).test(nextUrl))) {
                    url = nextUrl;
                    pages++;
                    continue;
                }
            }
        }
        break;
    }

    return { title, content: content.trim() };
}

// 清理章节正文：去广告、整理段落
function cleanChapterContent(raw, chapterConfig) {
    let text = raw;
    // 先按 paragraphTag 分段
    if (chapterConfig.paragraphTagClosed) {
        text = text.replace(/<p[^>]*>/gi, '\n').replace(/<\/p>/gi, '\n');
    } else if (chapterConfig.paragraphTag) {
        text = text.replace(/<br\s*\/?>/gi, '\n');
    }
    // 去标签
    text = text.replace(/<[^>]+>/g, '');
    // 解码 HTML 实体
    text = decodeEntities(text);
    // 过滤广告文本
    if (chapterConfig.filterTxt) {
        const patterns = chapterConfig.filterTxt.split('|');
        for (const p of patterns) {
            try {
                text = text.replace(new RegExp(p, 'g'), '');
            } catch {
                text = text.split(p).join('');
            }
        }
    }
    text = text.replace(/\n{3,}/g, '\n\n').trim();
    return text;
}

function decodeEntities(s) {
    return s
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&ldquo;/g, '"')
        .replace(/&rdquo;/g, '"');
}

module.exports = {
    fetchHtml,
    searchBySource,
    fetchBookInfo,
    fetchToc,
    fetchChapter,
    resolveUrl,
};
