/**
 * 解析器通用工具函数
 * 提供 DOM 解析、编码处理、路径处理等通用功能
 */
const { JSDOM } = require('jsdom');
const pako = require('pako');

// =====================
// 命名空间常量
// =====================

const NS = {
    CONTAINER: 'urn:oasis:names:tc:opendocument:xmlns:container',
    XHTML: 'http://www.w3.org/1999/xhtml',
    OPF: 'http://www.idpf.org/2007/opf',
    EPUB: 'http://www.idpf.org/2007/ops',
    DC: 'http://purl.org/dc/elements/1.1/',
    DCTERMS: 'http://purl.org/dc/terms/',
    ENC: 'http://www.w3.org/2001/04/xmlenc#',
    NCX: 'http://www.daisy.org/z3986/2005/ncx/',
    XLINK: 'http://www.w3.org/1999/xlink',
    SMIL: 'http://www.w3.org/ns/SMIL',
    FB2: 'http://www.gribuser.ru/xml/fictionbook/2.0',
};

const MIME = {
    XML: 'application/xml',
    NCX: 'application/x-dtbncx+xml',
    XHTML: 'application/xhtml+xml',
    HTML: 'text/html',
    CSS: 'text/css',
    SVG: 'image/svg+xml',
    JS: /\/(x-)?(javascript|ecmascript)/,
};

// =====================
// 文本处理工具
// =====================

function normalizeWhitespace(str) {
    if (!str) return '';
    return str.replace(/[\t\n\f\r ]+/g, ' ').replace(/^[\t\n\f\r ]+/, '').replace(/[\t\n\f\r ]+$/, '');
}

function getElementText(el) {
    return normalizeWhitespace(el?.textContent);
}

function unescapeHTML(str) {
    if (!str) return '';
    const dom = new JSDOM(`<!DOCTYPE html><body>${str}</body>`);
    return dom.window.document.body.textContent || '';
}

function camelCase(str) {
    return str.toLowerCase().replace(/[-:](.)/g, (_, g) => g.toUpperCase());
}

// =====================
// DOM 解析工具
// =====================

function parseXML(str, contentType = 'application/xml') {
    const dom = new JSDOM(str, { contentType });
    return dom.window.document;
}

function parseXMLWithEncoding(buffer) {
    let str = buffer.toString('utf-8');
    const dom = new JSDOM(str, { contentType: 'application/xml' });
    const doc = dom.window.document;

    const encodingMatch = str.match(/<\?xml\s+version\s*=\s*["']1.\d+"\s+encoding\s*=\s*["']([A-Za-z0-9._-]*)["']/);
    const encoding = encodingMatch?.[1]?.toLowerCase();

    if (encoding && encoding !== 'utf-8') {
        try {
            const iconv = require('iconv-lite');
            if (iconv.encodingExists(encoding)) {
                str = iconv.decode(buffer, encoding);
                return new JSDOM(str, { contentType: 'application/xml' }).window.document;
            }
        } catch (e) {
            console.warn('Failed to decode with encoding:', encoding, e);
        }
    }
    return doc;
}

function childGetter(doc, ns) {
    const useNS = doc.lookupNamespaceURI(null) === ns || doc.lookupPrefix(ns);
    const f = useNS
        ? (el, name) => el => el.namespaceURI === ns && el.localName === name
        : (el, name) => el => el.localName === name;

    return {
        $: (el, name) => [...el.children].find(f(el, name)),
        $$: (el, name) => [...el.children].filter(f(el, name)),
        $$$: useNS
            ? (el, name) => [...el.getElementsByTagNameNS(ns, name)]
            : (el, name) => [...el.getElementsByTagName(name)],
    };
}

function getAttributes(...attrs) {
    return el => {
        if (!el) return null;
        return Object.fromEntries(attrs.map(attr => [camelCase(attr), el.getAttribute(attr)]));
    };
}

// =====================
// 路径处理工具
// =====================

function resolveURL(url, relativeTo) {
    try {
        if (relativeTo.includes(':')) return new URL(url, relativeTo).href;
        const root = 'https://invalid.invalid/';
        const obj = new URL(url, root + relativeTo);
        obj.search = '';
        return decodeURI(obj.href.replace(root, ''));
    } catch (e) {
        return url;
    }
}

function isExternal(uri) {
    return /^(?!blob)\w+:/i.test(uri);
}

function pathRelative(from, to) {
    if (!from) return to;
    const as = from.replace(/\/$/, '').split('/');
    const bs = to.replace(/\/$/, '').split('/');
    const i = (as.length > bs.length ? as : bs).findIndex((_, i) => as[i] !== bs[i]);
    return i < 0 ? '' : Array(as.length - i).fill('..').concat(bs.slice(i)).join('/');
}

function pathDirname(str) {
    return str.slice(0, str.lastIndexOf('/') + 1);
}

// =====================
// 二进制处理工具
// =====================

function getUint(buffer, offset = 0, length) {
    if (!buffer || buffer.length === 0) return undefined;
    const len = length || buffer.length - offset;
    if (len === 4) return buffer.readUInt32BE(offset);
    if (len === 2) return buffer.readUInt16BE(offset);
    if (len === 1) return buffer.readUInt8(offset);
    return undefined;
}

function getString(buffer, offset = 0, length) {
    if (!buffer) return '';
    const end = length ? offset + length : buffer.length;
    return buffer.slice(offset, end).toString('utf-8').replace(/\0/g, '');
}

function getStruct(def, buffer) {
    return Object.fromEntries(
        Object.entries(def).map(([key, [start, len, type]]) => {
            if (type === 'string') return [key, getString(buffer, start, len)];
            else return [key, getUint(buffer, start, len)];
        })
    );
}

function concatTypedArray(a, b) {
    const result = Buffer.alloc(a.length + b.length);
    a.copy ? a.copy(result) : result.set(a);
    b.copy ? b.copy(result, a.length) : result.set(b, a.length);
    return result;
}

function countBitsSet(x) {
    let count = 0;
    for (; x > 0; x = x >> 1) if ((x & 1) === 1) count++;
    return count;
}

function countUnsetEnd(x) {
    let count = 0;
    while ((x & 1) === 0) x = x >> 1, count++;
    return count;
}

function getVarLen(byteArray, i = 0) {
    let value = 0, length = 0;
    for (const byte of byteArray.subarray(i, i + 4)) {
        value = (value << 7) | (byte & 0b111_1111) >>> 0;
        length++;
        if (byte & 0b1000_0000) break;
    }
    return { value, length };
}

function getVarLenFromEnd(byteArray) {
    let value = 0;
    for (const byte of byteArray.subarray(-4)) {
        if (byte & 0b1000_0000) value = 0;
        value = (value << 7) | (byte & 0b111_1111);
    }
    return value;
}

function read32Bits(byteArray, from) {
    const startByte = from >> 3;
    const end = from + 32;
    const endByte = end >> 3;
    let bits = 0n;
    for (let i = startByte; i <= endByte; i++) {
        bits = bits << 8n | BigInt(byteArray[i] ?? 0);
    }
    return (bits >> (8n - BigInt(end & 7))) & 0xffffffffn;
}

// =====================
// 解压缩工具
// =====================

function decompressPalmDOC(array) {
    let output = [];
    for (let i = 0; i < array.length; i++) {
        const byte = array[i];
        if (byte === 0) {
            output.push(0);
        } else if (byte <= 8) {
            for (const x of array.subarray(i + 1, (i += byte) + 1)) output.push(x);
        } else if (byte <= 0b0111_1111) {
            output.push(byte);
        } else if (byte <= 0b1011_1111) {
            const bytes = (byte << 8) | array[i++ + 1];
            const distance = (bytes & 0b0011_1111_1111_1111) >>> 3;
            const length = (bytes & 0b111) + 3;
            for (let j = 0; j < length; j++) output.push(output[output.length - distance]);
        } else {
            output.push(32, byte ^ 0b1000_0000);
        }
    }
    return Buffer.from(output);
}

function unzlib(data) {
    return Buffer.from(pako.inflate(data));
}

module.exports = {
    NS, MIME,
    normalizeWhitespace, getElementText, unescapeHTML, camelCase,
    parseXML, parseXMLWithEncoding, childGetter, getAttributes,
    resolveURL, isExternal, pathRelative, pathDirname,
    getUint, getString, getStruct, concatTypedArray,
    countBitsSet, countUnsetEnd, getVarLen, getVarLenFromEnd, read32Bits,
    decompressPalmDOC, unzlib,
};
