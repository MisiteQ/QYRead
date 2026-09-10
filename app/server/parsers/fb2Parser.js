/**
 * FB2 格式解析器
 * 支持 FictionBook 2.0 格式
 */
const fs = require('fs');
const { JSDOM } = require('jsdom');
const { normalizeWhitespace, getElementText, parseXMLWithEncoding, NS } = require('./utils');
const { createLRUCache, getFileCacheKey } = require('../utils/lruCache');

const STYLE = { 'strong': ['strong', 'self'], 'emphasis': ['em', 'self'], 'style': ['span', 'self'], 'a': 'anchor', 'strikethrough': ['s', 'self'], 'sub': ['sub', 'self'], 'sup': ['sup', 'self'], 'code': ['code', 'self'], 'image': 'image' };
const SECTION = { 'title': ['header', { 'p': ['h1', STYLE] }], 'p': ['p', STYLE], 'poem': ['blockquote', 'self'], 'cite': ['blockquote', 'self'], 'empty-line': ['br'], 'table': ['table', 'self'] };
const BODY = { 'image': 'image', 'title': ['section', { 'p': ['h1', STYLE] }], 'section': ['section', SECTION] };
const fb2DocumentCache = createLRUCache(4);

class FB2Converter {
    constructor(fb2Doc) { this.fb2 = fb2Doc; const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>'); this.doc = dom.window.document; }
    getImageSrc(el) {
        const href = el.getAttributeNS(NS.XLINK, 'href') || el.getAttribute('xlink:href') || el.getAttribute('l:href');
        if (!href) return 'data:,';
        const [, id] = href.split('#');
        if (!id) return href;
        const bin = this.fb2.getElementById(id);
        if (bin) return `data:${bin.getAttribute('content-type') || 'image/jpeg'};base64,${bin.textContent.trim()}`;
        return href;
    }
    image(node) { const el = this.doc.createElement('img'); el.alt = node.getAttribute('alt') || ''; el.setAttribute('src', this.getImageSrc(node)); return el; }
    anchor(node) { const el = this.convert(node, { 'a': ['a', STYLE] }); if (!el) return null; const href = node.getAttributeNS(NS.XLINK, 'href') || node.getAttribute('xlink:href') || node.getAttribute('l:href'); if (href) el.setAttribute('href', href); return el; }
    convert(node, def) {
        if (node.nodeType === 3 || node.nodeType === 4) return this.doc.createTextNode(node.textContent);
        if (node.nodeType === 8) return this.doc.createComment(node.textContent);
        const d = def?.[node.nodeName];
        if (!d) return null;
        if (typeof d === 'string') return this[d](node);
        const [name, opts] = d;
        const el = this.doc.createElement(name);
        if (node.id) el.id = node.id;
        el.classList.add(node.nodeName);
        const childDef = opts === 'self' ? def : opts;
        let child = node.firstChild;
        while (child) { const childEl = this.convert(child, childDef); if (childEl) el.append(childEl); child = child.nextSibling; }
        return el;
    }
}

const FB2_STYLE = `body>img,section>img{display:block;margin:auto}.title h1{text-align:center}p{text-indent:1em;margin:0}:not(p)+p,p:first-child{text-indent:0}.text-author{text-align:end}`;

function getCachedDocument(filepath) {
    const cacheKey = getFileCacheKey(filepath, 'fb2-document');
    const cached = fb2DocumentCache.get(cacheKey);
    if (cached) return cached;

    const buffer = fs.readFileSync(filepath);
    const doc = parseXMLWithEncoding(buffer);
    const value = { doc };
    fb2DocumentCache.set(cacheKey, value);
    return value;
}

async function parseToc({ book, isStream, coverUrl, res, mtime }) {
    try {
        const { doc } = getCachedDocument(book.filepath);
        const $ = x => doc.querySelector(x), $$ = x => [...doc.querySelectorAll(x)];
        const getPerson = el => { const nick = getElementText(el.querySelector('nickname')); if (nick) return nick; return [getElementText(el.querySelector('first-name')), getElementText(el.querySelector('middle-name')), getElementText(el.querySelector('last-name'))].filter(x => x).join(' '); };
        const metadata = { title: getElementText($('title-info book-title')), identifier: getElementText($('document-info id')), language: getElementText($('title-info lang')), author: $$('title-info author').map(getPerson), publisher: getElementText($('publish-info publisher')), published: $('title-info date')?.getAttribute('value') || getElementText($('title-info date')) };
        const bodies = doc.querySelectorAll('body');
        const toc = [];
        for (let bodyIndex = 0; bodyIndex < bodies.length; bodyIndex++) {
            const sections = bodies[bodyIndex].querySelectorAll(':scope > section');
            for (let secIndex = 0; secIndex < sections.length; secIndex++) {
                const section = sections[secIndex];
                const titleEl = section.querySelector(':scope > title');
                toc.push({ title: (titleEl ? getElementText(titleEl) : null) || `第 ${toc.length + 1} 章`, index: toc.length, bodyIndex, sectionIndex: secIndex });
            }
        }
        if (toc.length === 0) toc.push({ title: metadata.title || '正文', index: 0 });
        const response = { type: 'complete', toc, format: 'fb2', title: metadata.title || book.title, author: metadata.author, in_bookshelf: book.in_bookshelf, cover: coverUrl, mtime: mtime || 0 };
        if (isStream && res) { res.write(`data: ${JSON.stringify(response)}\n\n`); res.end(); return null; }
        return response;
    } catch (e) {
        console.error('FB2 TOC Error:', e);
        if (isStream && res) { res.write(`data: ${JSON.stringify({ type: 'error', error: 'FB2 Parse Failed: ' + e.message })}\n\n`); res.end(); return null; }
        throw new Error('FB2 Parse Failed: ' + e.message);
    }
}

async function loadChapter({ book, index }) {
    const { doc } = getCachedDocument(book.filepath);
    const converter = new FB2Converter(doc);
    const bodies = doc.querySelectorAll('body');
    let currentIndex = 0, targetSection = null;
    for (const body of bodies) {
        const sections = body.querySelectorAll(':scope > section');
        for (const section of sections) { if (currentIndex === index) { targetSection = section; break; } currentIndex++; }
        if (targetSection) break;
    }
    if (!targetSection && bodies.length > 0) targetSection = bodies[0];
    if (!targetSection) return { content: '' };
    const converted = converter.convert(targetSection, { body: ['div', BODY], section: ['section', SECTION] });
    return { content: `<style>${FB2_STYLE}</style>${converted ? converted.outerHTML : ''}` };
}

async function extractImage({ book, imagePath, res }) {
    try {
        const { doc } = getCachedDocument(book.filepath);
        const id = imagePath.replace(/^#/, '');
        const bin = doc.getElementById(id);
        if (bin) {
            const contentType = bin.getAttribute('content-type') || 'image/jpeg';
            const imageBuffer = Buffer.from(bin.textContent.trim(), 'base64');
            res.setHeader('Content-Type', contentType);
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.send(imageBuffer);
        } else res.status(404).json({ error: 'Image not found in FB2' });
    } catch (e) { console.error('FB2 Image Extract Error:', e); res.status(500).json({ error: 'Failed to extract image: ' + e.message }); }
}

function getSupportedFormats() { return ['fb2']; }
module.exports = { parseToc, loadChapter, extractImage, getSupportedFormats, FB2Converter };
