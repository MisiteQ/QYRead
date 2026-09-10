/**
 * EPUB 格式解析器
 * 支持 EPUB2(NCX) 和 EPUB3(Nav) 格式
 */
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const mime = require('mime-types');
const { normalizeWhitespace, getElementText, parseXML, resolveURL, pathDirname, NS, MIME } = require('./utils');
const { createLRUCache, getFileCacheKey } = require('../utils/lruCache');

const readerCache = createLRUCache(3);
const readerInitCache = createLRUCache(3);

function parseNav(doc, resolve = f => f) {
    const resolveHref = href => href ? decodeURI(resolve(href)) : null;
    const parseLI = getType => $li => {
        const $a = $li.querySelector('a') ?? $li.querySelector('span');
        const $ol = $li.querySelector('ol');
        const href = $a?.tagName?.toLowerCase() === 'a' ? resolveHref($a?.getAttribute('href')) : null;
        const label = getElementText($a) || $a?.getAttribute('title') || 'Untitled';
        const subitems = $ol ? [...$ol.querySelectorAll(':scope > li')].map(parseLI(getType)) : null;
        const result = { label, href, subitems };
        if (getType) result.type = $a?.getAttribute('epub:type')?.split(/\s/);
        return result;
    };

    const $$nav = [...doc.querySelectorAll('nav')];
    let toc = null;
    
    // 优先寻找带有 epub:type="toc" 的 nav
    for (const $nav of $$nav) {
        const type = $nav.getAttribute('epub:type')?.split(/\s/) ?? [];
        if (type.includes('toc')) {
            const $ol = $nav.querySelector('ol');
            if ($ol) {
                toc = [...$ol.querySelectorAll(':scope > li')].map(parseLI(false));
                break;
            }
        }
    }
    
    // 如果没找到带 type 的，找第一个包含 ol 的 nav
    if (!toc) {
        for (const $nav of $$nav) {
            const $ol = $nav.querySelector('ol');
            if ($ol) {
                toc = [...$ol.querySelectorAll(':scope > li')].map(parseLI(false));
                break;
            }
        }
    }
    
    return { toc };
}

function parseNCX(doc, resolve = f => f) {
    const resolveHref = href => href ? decodeURI(resolve(href)) : null;
    const parseItem = el => {
        const $label = el.querySelector('navLabel');
        const $content = el.querySelector('content');
        const label = getElementText($label);
        const href = resolveHref($content?.getAttribute('src'));
        const els = [...el.querySelectorAll(':scope > navPoint')];
        return { label, href, subitems: els.length ? els.map(parseItem) : null };
    };
    const $navMap = doc.querySelector('navMap');
    return { toc: $navMap ? [...$navMap.querySelectorAll(':scope > navPoint')].map(parseItem) : null };
}

class EPUBReader {
    constructor(filepath) {
        if (!fs.existsSync(filepath)) {
            throw new Error(`EPUB 文件不存在: ${path.basename(filepath)}`);
        }
        const stat = fs.statSync(filepath);
        if (stat.size === 0) {
            throw new Error(`EPUB 文件大小为 0 字节，请重新上传该文件`);
        }
        try {
            this.filepath = filepath;
            this.zip = new AdmZip(filepath);
        } catch (err) {
            if (err.message && err.message.includes('Invalid CEN header')) {
                throw new Error(`EPUB 文件结构已损坏或网络传输不完整 (${err.message})，请尝试重新上传该图书`);
            }
            throw err;
        }
        this.manifest = {};
        this.spine = [];
        this.metadata = {};
        this.toc = [];
        this.opfPath = '';
    }

    loadText(entryPath) { const e = this.zip.getEntry(entryPath); return e ? this.zip.readAsText(e) : null; }
    loadBlob(entryPath) { const e = this.zip.getEntry(entryPath); return e ? this.zip.readFile(e) : null; }
    loadXML(entryPath) { const str = this.loadText(entryPath); return str ? parseXML(str, 'application/xml') : null; }

    async init() {
        const container = this.loadXML('META-INF/container.xml');
        if (!container) throw new Error('Failed to load container');
        const rootfiles = container.getElementsByTagNameNS(NS.CONTAINER, 'rootfile');
        if (rootfiles.length === 0) throw new Error('No rootfile found');
        this.opfPath = rootfiles[0].getAttribute('full-path');
        const opfDir = pathDirname(this.opfPath);

        const opf = this.loadXML(this.opfPath);
        if (!opf) throw new Error('Failed to load OPF');

        const manifestEl = opf.getElementsByTagNameNS(NS.OPF, 'manifest')[0];
        if (manifestEl) {
            for (const item of manifestEl.getElementsByTagNameNS(NS.OPF, 'item')) {
                const id = item.getAttribute('id'), href = item.getAttribute('href'),
                    mediaType = item.getAttribute('media-type'),
                    properties = item.getAttribute('properties')?.split(/\s/) || [];
                this.manifest[id] = { id, href: resolveURL(href, this.opfPath), mediaType, properties };
            }
        }

        const spineEl = opf.getElementsByTagNameNS(NS.OPF, 'spine')[0];
        if (spineEl) {
            for (const itemref of spineEl.getElementsByTagNameNS(NS.OPF, 'itemref')) {
                this.spine.push({ idref: itemref.getAttribute('idref'), linear: itemref.getAttribute('linear') });
            }
        }

        const getDC = name => { const els = opf.getElementsByTagNameNS(NS.DC, name); return els.length > 0 ? getElementText(els[0]) : null; };
        this.metadata = {
            identifier: getDC('identifier'), title: getDC('title'), language: getDC('language'),
            description: getDC('description'), publisher: getDC('publisher'), published: getDC('date'), author: []
        };
        for (const c of opf.getElementsByTagNameNS(NS.DC, 'creator')) this.metadata.author.push(getElementText(c));

        await this.parseTOC(opf);
        return this;
    }

    async parseTOC(opf) {
        const navItem = Object.values(this.manifest).find(item => item.properties?.includes('nav'));
        if (navItem) {
            try {
                const navDoc = this.loadXML(navItem.href);
                if (navDoc) { const nav = parseNav(navDoc, url => resolveURL(url, navItem.href)); if (nav.toc) { this.toc = this.flattenTOC(nav.toc); return; } }
            } catch (e) { console.warn('Nav parse failed:', e); }
        }
        const spineEl = opf.getElementsByTagNameNS(NS.OPF, 'spine')[0];
        const tocId = spineEl?.getAttribute('toc');
        const ncxItem = tocId ? this.manifest[tocId] : Object.values(this.manifest).find(item => item.mediaType === MIME.NCX);
        if (ncxItem) {
            try {
                const ncxDoc = this.loadXML(ncxItem.href);
                if (ncxDoc) { const ncx = parseNCX(ncxDoc, url => resolveURL(url, ncxItem.href)); if (ncx.toc) { this.toc = this.flattenTOC(ncx.toc); return; } }
            } catch (e) { console.warn('NCX parse failed:', e); }
        }
        this.toc = this.spine.map((item, index) => ({ title: this.manifest[item.idref]?.id || `Chapter ${index + 1}`, href: this.manifest[item.idref]?.href, index }));
    }

    flattenTOC(items, level = 0) {
        const result = [];
        const flatten = (items, level) => { if (!items) return; for (const item of items) { result.push({ title: item.label || `Chapter ${result.length + 1}`, href: item.href, index: result.length, level }); if (item.subitems) flatten(item.subitems, level + 1); } };
        flatten(items, 0);
        return result;
    }
}

async function getCachedReader(filepath) {
    const cacheKey = getFileCacheKey(filepath, 'epub-reader');
    const cachedReader = readerCache.get(cacheKey);
    if (cachedReader) {
        return cachedReader;
    }

    const pendingReader = readerInitCache.get(cacheKey);
    if (pendingReader) {
        return pendingReader;
    }

    const initPromise = (async () => {
        const reader = new EPUBReader(filepath);
        await reader.init();
        readerCache.set(cacheKey, reader);
        readerInitCache.delete(cacheKey);
        return reader;
    })();

    readerInitCache.set(cacheKey, initPromise);
    try {
        return await initPromise;
    } catch (error) {
        readerInitCache.delete(cacheKey);
        throw error;
    }
}

function injectEpubStyles(rawHtml) {
    if (!rawHtml) return rawHtml;
    if (rawHtml.includes('data-reader-style="epub"')) return rawHtml;
    const styleTag = `<style data-reader-style="epub">` +
        `a[href^="#"],a[href*="#"],a[epub\\:type="noteref"],a.noteref,sup a{color:#2563eb !important;text-decoration:underline !important;}` +
        `p{text-indent:2em !important;margin:0 0 0.8em 0 !important;}` +
        `h1,h2,h3,h4,h5,h6,.chapter-title,.title{text-indent:0 !important;}` +
        `</style>`;
    if (/<\/head>/i.test(rawHtml)) {
        return rawHtml.replace(/<\/head>/i, `${styleTag}</head>`);
    }
    if (/<body[^>]*>/i.test(rawHtml)) {
        return rawHtml.replace(/<body[^>]*>/i, match => `${match}${styleTag}`);
    }
    return `${styleTag}${rawHtml}`;
}

/**
 * 解析目录 (TOC)
 * 改进逻辑：
 * 1. 优先使用原书定义的目录 (Nav/NCX)，保留层级结构和锚点跳转。
 * 2. 如果原书目录缺失或项数太少，则回退到基于 Spine 的平铺目录。
 */
async function parseToc({ book, isStream, coverUrl, res, mtime }) {
    try {
        const reader = await getCachedReader(book.filepath);

        let finalToc = [];

        // 构建 bareHref -> tocItem 映射
        const hrefToTocItem = new Map();
        if (reader.toc) {
            reader.toc.forEach(item => {
                if (item.href) {
                    const bareHref = item.href.split('#')[0];
                    if (!hrefToTocItem.has(bareHref)) {
                        hrefToTocItem.set(bareHref, item);
                    }
                }
            });
        }

        // 检查 Spine 中的文件是否完全被 reader.toc 覆盖
        const linearSpineItems = reader.spine.filter(itemRef => itemRef.linear !== 'no');
        let unmappedSpineCount = 0;
        linearSpineItems.forEach(itemRef => {
            const manifestItem = reader.manifest[itemRef.idref];
            if (manifestItem?.href) {
                const bareHref = manifestItem.href.split('#')[0];
                if (!hrefToTocItem.has(bareHref)) {
                    unmappedSpineCount++;
                }
            }
        });

        // 1. 如果原书目录 (Nav/NCX) 覆盖了所有的 Spine 文件，优先使用 Nav/NCX 的目录树 (保留层级和锚点)
        if (reader.toc && reader.toc.length > 2 && unmappedSpineCount === 0) {
            finalToc = reader.toc.map((item, index) => ({
                title: item.title,
                id: item.href, // 保留完整的 href (含锚点) 作为 id
                href: item.href,
                index: index,
                level: item.level || 0
            }));
        } else {
            // 2. 如果原书目录缺失、条目太少、或遗漏了 Spine 中的 XHTML 文件，遍历 Spine 构建完整章节流
            let lastTitle = '';
            linearSpineItems.forEach((itemRef, index) => {
                const manifestItem = reader.manifest[itemRef.idref];
                if (!manifestItem) return;

                const href = manifestItem.href;
                const bareHref = href.split('#')[0];
                const tocItem = hrefToTocItem.get(bareHref);

                let title = '';
                let level = 0;

                if (tocItem) {
                    title = tocItem.title;
                    level = tocItem.level || 0;
                    lastTitle = title;
                } else if (index === 0) {
                    title = "Start";
                } else {
                    title = lastTitle ? `${lastTitle} (续)` : `Chapter ${index + 1}`;
                }

                finalToc.push({
                    title: title,
                    id: href,
                    href: href,
                    index: finalToc.length,
                    level: level
                });
            });
        }

        // 如果依然没有目录，最后回退逻辑
        if (finalToc.length === 0 && reader.toc && reader.toc.length > 0) {
            finalToc = reader.toc.map((item, index) => ({
                title: item.title,
                id: item.href,
                href: item.href,
                index: index,
                level: item.level || 0
            }));
        }

        const response = {
            type: 'complete',
            toc: finalToc,
            format: 'epub',
            title: reader.metadata.title || book.title,
            author: reader.metadata.author ? reader.metadata.author.join(', ') : '',
            publisher: reader.metadata.publisher || '',
            in_bookshelf: book.in_bookshelf,
            cover: coverUrl,
            mtime: mtime || 0
        };

        if (isStream && res) {
            res.write(`data: ${JSON.stringify(response)}\n\n`);
            res.end();
            return null;
        }

        return response;

    } catch (e) {
        console.error('EPUB TOC Error:', e);
        const errorMsg = 'EPUB Parse Failed: ' + e.message;
        if (isStream && res) {
            res.write(`data: ${JSON.stringify({ type: 'error', error: errorMsg })}\n\n`);
            res.end();
            return null;
        }
        throw new Error(errorMsg);
    }
}

async function loadChapter({ book, href, bookId, token }) {
    if (!href) throw new Error('Href required for EPUB chapter');
    const reader = await getCachedReader(book.filepath);
    let chapterHref = href.includes('#') ? href.split('#')[0] : href;
    let manifestItem = Object.values(reader.manifest).find(item => item.href === chapterHref || item.href === decodeURI(chapterHref));
    if (!manifestItem) manifestItem = Object.values(reader.manifest).find(item => item.href.endsWith(chapterHref) || item.href.endsWith(decodeURI(chapterHref)));
    if (!manifestItem) throw new Error('Chapter not found in manifest');
    let text = reader.loadText(manifestItem.href);
    if (!text) throw new Error('Failed to read chapter content');
    const currentDir = pathDirname(manifestItem.href);
    text = rewriteImagePaths(text, currentDir, bookId, token);
    text = injectEpubStyles(text);
    return { content: text };
}

function rewriteImagePaths(text, currentDir, bookId, token) {
    return text.replace(/(src|href)="([^"]+)"/g, (match, attr, val) => {
        if (val.startsWith('http') || val.startsWith('https') || val.startsWith('#') || val.startsWith('mailto:')) return match;
        let decodedVal = val; try { decodedVal = decodeURIComponent(val); } catch (e) { }
        let targetPath = decodedVal;
        if (decodedVal.startsWith('/')) { targetPath = decodedVal.substring(1); }
        else {
            const currentDirParts = currentDir === '.' ? [] : currentDir.split('/').filter(Boolean);
            const valParts = decodedVal.split('/');
            for (const p of valParts) { if (p === '..') { if (currentDirParts.length > 0) currentDirParts.pop(); } else if (p !== '.') { currentDirParts.push(p); } }
            targetPath = currentDirParts.join('/');
        }
        if (targetPath.match(/\.(jpg|jpeg|png|gif|svg|webp|bmp|tif|tiff)$/i)) {
            let url = `/api/books/${bookId}/image?path=${encodeURIComponent(targetPath)}`;
            if (token) url += `&token=${token}`;
            return `${attr}="${url}" loading="lazy" decoding="async"`;
        }
        return match;
    });
}

function extractImage({ book, imagePath, res }) {
    try {
        let targetPath = decodeURIComponent(imagePath).replace(/\\/g, '/');
        if (targetPath.startsWith('/')) targetPath = targetPath.substring(1);
        const cacheKey = getFileCacheKey(book.filepath, 'epub-reader');
        const reader = readerCache.get(cacheKey) || new EPUBReader(book.filepath);
        const zip = reader.zip || new AdmZip(book.filepath);
        const entries = zip.getEntries();
        let entry = entries.find(e => e.entryName === targetPath) || entries.find(e => e.entryName.toLowerCase() === targetPath.toLowerCase()) ||
            entries.find(e => e.entryName.endsWith(targetPath.split('/').filter(p => p !== '..').join('/'))) || entries.find(e => path.basename(e.entryName) === path.basename(targetPath));
        if (entry) {
            const buffer = zip.readFile(entry);
            res.setHeader('Content-Type', mime.lookup(entry.entryName) || 'application/octet-stream');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.send(buffer);
        } else { res.status(404).json({ error: 'Image not found in archive' }); }
    } catch (e) {
        // 403/Permission errors usually mean the path is outside the zip or invalid
        // User requested: "获取不到就不要显示", so we return 404 to fail gracefully
        console.warn('EPUB Image Extract Warning:', e.message);
        res.status(404).json({ error: 'Image extraction failed or denied' });
    }
}

function getSupportedFormats() { return ['epub']; }

module.exports = { parseToc, loadChapter, extractImage, rewriteImagePaths, getSupportedFormats, EPUBReader, parseNav, parseNCX };
