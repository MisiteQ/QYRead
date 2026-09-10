/**
 * MOBI/AZW3 格式解析器
 * 基于 foliate-js 移植版 (foliateMobiParser.js) 实现
 * 替代旧的 @lingo-reader/mobi-parser 实现，以支持 Combo MOBI/KF8 和更完善的格式解析
 */
const foliateMobiParser = require('./foliateMobiParser');
const { JSDOM } = require('jsdom');
const path = require('path');
const os = require('os');
const fs = require('fs');

// 保持接口兼容的辅助函数
function getResourceDir(bookId) {
    return path.join(os.tmpdir(), 'mobi-resources', String(bookId));
}

function ensureResourceDir(bookId) {
    const resourceDir = getResourceDir(bookId);
    if (!fs.existsSync(resourceDir)) {
        fs.mkdirSync(resourceDir, { recursive: true });
    }
    return resourceDir;
}

function applyReaderStyles(doc) {
    const body = doc.body || doc.documentElement;
    if (!body) return;
    const titlePattern = /(title|chapter|heading)/i;
    const isTitleLike = (el) => {
        if (!el) return false;
        const cls = el.getAttribute('class') || '';
        const id = el.getAttribute('id') || '';
        if (titlePattern.test(cls) || titlePattern.test(id)) return true;
        if (el === body.firstElementChild) return true;
        if (el.querySelector && el.querySelector('h1,h2,h3,h4,h5,h6')) return true;
        return false;
    };
    const noteLinks = [...body.querySelectorAll('a')].filter(a => {
        const href = a.getAttribute('href') || '';
        const cls = a.getAttribute('class') || '';
        const text = a.textContent ? a.textContent.trim() : '';
        const isHash = href.startsWith('#') || href.includes('#');
        const inSup = !!a.closest('sup');
        const isNoteRef = /noteref/i.test(cls) || inSup;
        const shortRef = text.length > 0 && text.length <= 3;
        return isNoteRef || (isHash && shortRef);
    });
    for (const a of noteLinks) {
        a.classList.add('epub-note-ref');
        a.style.setProperty('color', '#2563eb', 'important');
        a.style.setProperty('text-decoration', 'underline', 'important');
    }
    body.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h => {
        h.style.setProperty('text-indent', '0', 'important');
    });
    body.querySelectorAll('p').forEach(p => {
        if (isTitleLike(p)) return;
        p.style.setProperty('text-indent', '2em', 'important');
        p.style.setProperty('margin-bottom', '0.8em', 'important');
        p.style.setProperty('margin-top', '0', 'important');
    });
    const blockSelector = 'p,div,section,article,aside,nav,figure,table,ul,ol,li,blockquote,pre,code,h1,h2,h3,h4,h5,h6,hr';
    body.querySelectorAll('div').forEach(div => {
        if (!div.textContent || !div.textContent.trim()) return;
        if (div.querySelector(blockSelector)) return;
        if (isTitleLike(div)) return;
        div.style.setProperty('text-indent', '2em', 'important');
        div.style.setProperty('margin-bottom', '0.8em', 'important');
        div.style.setProperty('margin-top', '0', 'important');
    });
}

/**
 * HTML 清理与资源路径重写
 */
function cleanHtml(rawHtml, bookId) {
    if (!rawHtml) return '';

    // 预处理：移除 XML 声明和 DOCTYPE
    let html = rawHtml
        .replace(/<\?xml[\s\S]*?\?>/gi, '')
        .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
        .replace(/(?:^|[\s\S])version\s*=\s*['"]1\.\d+['"][\s\S]*?\?>/gi, '')
        .replace(/(?:^|[\s\S])TYPE\s+html\s+PUBLIC[\s\S]*?>/gi, '');

    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // 1. 移除干扰标签
    const tagsToRemove = ['script', 'style', 'link', 'meta', 'title', 'xml', 'head'];
    tagsToRemove.forEach(tag => {
        doc.querySelectorAll(tag).forEach(el => el.remove());
    });

    // 2. 移除 mbp 标签和空 filepos 锚点
    doc.querySelectorAll('*').forEach(el => {
        const tagName = el.tagName.toLowerCase();
        if (tagName.startsWith('mbp:')) {
            if (tagName === 'mbp:pagebreak') {
                el.remove();
            } else {
                el.replaceWith(...el.childNodes);
            }
        }
    });
    doc.querySelectorAll('a[id^="filepos"]').forEach(a => {
        if (!a.hasAttribute('href') && !a.textContent.trim()) {
            a.remove();
        }
    });

    // 3. 重写图片路径
    const rewriteSrc = (src) => {
        if (!src) return null;
        if (src.startsWith('http') || src.startsWith('data:') || src.startsWith('/api/')) return null;
        if (src.length > 256) return null;
        if (/[<>"']/.test(src)) return null;

        // foliate-js 使用 kindle:embed:xxxx 或 recindex:xxxx
        // 我们将其保留完整，以便 extractImage 可以解析
        if (src.startsWith('kindle:')) {
            if (!/^kindle:(?:embed|flow):[0-9a-zA-Z]+(?:\?mime=[^"'\s]+)?$/.test(src)) return null;
            return `/api/books/${bookId}/image?path=${encodeURIComponent(src)}`;
        }
        if (src.startsWith('recindex:')) {
            if (!/^recindex:\d+$/.test(src)) return null;
            return `/api/books/${bookId}/image?path=${encodeURIComponent(src)}`;
        }
        
        // 相对路径或文件名
        return `/api/books/${bookId}/image?path=${encodeURIComponent(src)}`;
    };

    doc.querySelectorAll('[src]').forEach(el => {
        const newSrc = rewriteSrc(el.getAttribute('src'));
        if (newSrc) {
            el.setAttribute('src', newSrc);
            if (el.tagName.toLowerCase() === 'img') {
                el.setAttribute('loading', 'lazy');
                el.setAttribute('decoding', 'async');
            }
        }
    });

    doc.querySelectorAll('image[href], image[xlink\\:href]').forEach(el => {
        const attr = el.hasAttribute('href') ? 'href' : 'xlink:href';
        const newSrc = rewriteSrc(el.getAttribute(attr));
        if (newSrc) el.setAttribute(attr, newSrc);
    });

    applyReaderStyles(doc);

    // 4. 提取内容
    let cleanContent = doc.body ? doc.body.innerHTML : doc.documentElement.innerHTML;
    
    // 简单移除控制字符
    cleanContent = cleanContent.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

    return cleanContent;
}

/**
 * 解析目录 (TOC)
 */
async function parseToc({ book, isStream, coverUrl, res, mtime }) {
    try {
        const result = await foliateMobiParser.parseToc({ book });
        
        // 补充封面信息 (foliateMobiParser 暂不提取封面，使用传入的 coverUrl)
        result.cover = coverUrl;
        result.in_bookshelf = book.in_bookshelf;
        result.mtime = mtime || 0;

        if (isStream && res) {
            res.write(`data: ${JSON.stringify(result)}\n\n`);
            res.end();
            return null;
        }

        return result;
    } catch (e) {
        console.error('MOBI TOC Error (Foliate):', e);
        if (isStream && res) {
            res.write(`data: ${JSON.stringify({ type: 'error', error: 'MOBI Parse Failed: ' + e.message })}\n\n`);
            res.end();
            return null;
        }
        throw e;
    }
}

/**
 * 加载章节内容
 */
async function loadChapter({ book, index }) {
    try {
        const { content } = await foliateMobiParser.loadChapter({ book, index });
        const cleanContent = cleanHtml(content, book.id);
        return { content: cleanContent };
    } catch (e) {
        console.error('MOBI Chapter Error:', e);
        throw e;
    }
}

/**
 * 提取图片
 */
async function extractImage({ book, imagePath, res }) {
    try {
        // foliateMobiParser 直接处理流式响应
        await foliateMobiParser.extractImage({ book, imagePath, res });
    } catch (e) {
        console.error('MOBI Image Extract Error:', e);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to extract image: ' + e.message });
        }
    }
}

function getSupportedFormats() { return ['mobi', 'azw3']; }

module.exports = { parseToc, loadChapter, extractImage, getSupportedFormats, getResourceDir, ensureResourceDir };
