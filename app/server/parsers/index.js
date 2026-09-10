/**
 * 格式解析器注册中心
 * 提供统一的解析器获取接口和格式路由分发
 */
const txtParser = require('./txtParser');
const epubParser = require('./epubParser');
const mobiParser = require('./mobiParser');
const pdfParser = require('./pdfParser');
const fb2Parser = require('./fb2Parser');
const comicParser = require('./comicParser');

const parsers = {
    txt: txtParser, md: txtParser,
    epub: epubParser,
    mobi: mobiParser, azw3: mobiParser, azw: mobiParser, prc: mobiParser,
    fb2: fb2Parser,
    pdf: pdfParser,
    cbz: comicParser, cbr: comicParser, cb7: comicParser, zip: comicParser,
};

function getParser(format) { return parsers[format?.toLowerCase()] || null; }
function supportsToc(format) { const parser = getParser(format); return parser && typeof parser.parseToc === 'function'; }
function supportsChapter(format) { const parser = getParser(format); return parser && typeof parser.loadChapter === 'function'; }
function supportsImage(format) { const parser = getParser(format); return parser && typeof parser.extractImage === 'function'; }
function supportsContent(format) { const parser = getParser(format); return parser && typeof parser.loadContent === 'function'; }
function getSupportedFormats() { return Object.keys(parsers); }
function getFormatsByCategory() { return { text: ['txt', 'md'], ebook: ['epub', 'mobi', 'azw3', 'azw', 'prc', 'fb2'], document: ['pdf'], comic: ['cbz', 'cbr', 'cb7'] }; }
function getCapabilityMatrix() {
    const matrix = {};
    for (const [format, parser] of Object.entries(parsers)) {
        matrix[format] = { toc: typeof parser.parseToc === 'function', chapter: typeof parser.loadChapter === 'function', image: typeof parser.extractImage === 'function', content: typeof parser.loadContent === 'function', stream: typeof parser.streamPdf === 'function' };
    }
    return matrix;
}
function getFormatFromFilename(filename) { return filename.toLowerCase().split('.').pop(); }
function isFormatSupported(format) { return format?.toLowerCase() in parsers; }

module.exports = {
    getParser, parsers,
    supportsToc, supportsChapter, supportsImage, supportsContent,
    getSupportedFormats, getFormatsByCategory, getCapabilityMatrix, getFormatFromFilename, isFormatSupported,
    txtParser, epubParser, mobiParser, pdfParser, fb2Parser, comicParser,
};
