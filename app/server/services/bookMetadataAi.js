const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const {
    txtParser,
    epubParser,
    mobiParser,
    fb2Parser,
    comicParser
} = require('../parsers');

const METADATA_FIELDS = ['author', 'publisher', 'description', 'published_year', 'isbn'];
const SESSION_TTL_MS = 30 * 60 * 1000;
const MISSING_MARKERS = new Set([
    '',
    '-',
    '--',
    '—',
    '——',
    '_',
    '__',
    'n/a',
    'na',
    'null',
    'undefined',
    'unknown',
    '未知',
    '未知作者',
    '未知出版社',
    '佚名',
    '暂无',
    '未填写',
    '待补充',
    '无'
]);

function normalizeScalar(value) {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) {
        return value
            .map(item => normalizeScalar(item))
            .filter(Boolean)
            .join(', ');
    }
    return String(value).replace(/\s+/g, ' ').trim();
}

function isMetadataMissing(value) {
    const normalized = normalizeScalar(value).toLowerCase();
    if (!normalized) return true;
    return MISSING_MARKERS.has(normalized);
}

function sanitizeCandidateValue(field, value) {
    const normalized = normalizeScalar(value);
    if (isMetadataMissing(normalized)) {
        return null;
    }

    switch (field) {
        case 'author':
        case 'publisher':
            return normalized.slice(0, 120);
        case 'description':
            return normalized.slice(0, 4000);
        case 'published_year': {
            const matched = normalized.match(/(1[0-9]{3}|20[0-9]{2}|2100)/);
            if (!matched) return null;
            return matched[1];
        }
        case 'isbn': {
            const compact = normalized.replace(/[^0-9Xx]/g, '').toUpperCase();
            if (compact.length !== 10 && compact.length !== 13) return null;
            return compact;
        }
        default:
            return normalized || null;
    }
}

function getMissingMetadataFields(book = {}) {
    return METADATA_FIELDS.filter(field => isMetadataMissing(book[field]));
}

function mergeMetadataUpdates(existing = {}, candidate = {}) {
    const updates = {};
    for (const field of METADATA_FIELDS) {
        if (!isMetadataMissing(existing[field])) {
            continue;
        }
        const sanitized = sanitizeCandidateValue(field, candidate[field]);
        if (sanitized) {
            updates[field] = sanitized;
        }
    }
    return updates;
}

function stripHtmlTags(content = '') {
    return String(content)
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function extractEpubLikeContent(book, parser) {
    const tocResult = await parser.parseToc({
        book,
        isStream: false,
        coverUrl: '',
        res: null,
        mtime: 0
    });
    const toc = Array.isArray(tocResult?.toc) ? tocResult.toc : [];
    const first = toc[0];
    if (!first) {
        return { tocSample: [], contentSample: '' };
    }

    let chapterResult = null;
    if (parser === epubParser) {
        chapterResult = await parser.loadChapter({ book, href: first.href, bookId: book.id });
    } else if (parser === mobiParser || parser === fb2Parser || parser === comicParser) {
        chapterResult = await parser.loadChapter({ book, index: first.index || 0 });
    }

    return {
        tocSample: toc.slice(0, 8).map(item => item.title).filter(Boolean),
        contentSample: stripHtmlTags(chapterResult?.content || '')
    };
}

async function extractTxtContent(book) {
    const result = await txtParser.loadContent({ book });
    return {
        tocSample: [],
        contentSample: normalizeScalar(result?.rawContent || result?.content || '')
    };
}

async function extractPdfContent(book) {
    const buffer = fs.readFileSync(book.filepath);
    const result = await pdfParse(buffer);
    return {
        tocSample: [],
        contentSample: normalizeScalar(result?.text || '')
    };
}

async function extractBookMetadataContext(book = {}) {
    const format = normalizeScalar(book.format).toLowerCase();
    const context = {
        title: normalizeScalar(book.title),
        format,
        filepath: normalizeScalar(book.filepath),
        existingMetadata: {
            author: normalizeScalar(book.author),
            publisher: normalizeScalar(book.publisher),
            description: normalizeScalar(book.description),
            published_year: normalizeScalar(book.published_year),
            isbn: normalizeScalar(book.isbn)
        },
        tocSample: [],
        contentSample: '',
        warnings: []
    };

    if (!book.filepath || !fs.existsSync(book.filepath)) {
        context.warnings.push('源文件不存在，仅能依据数据库与文件名推断。');
        return context;
    }

    try {
        if (format === 'txt' || format === 'md') {
            Object.assign(context, await extractTxtContent(book));
        } else if (format === 'epub') {
            Object.assign(context, await extractEpubLikeContent(book, epubParser));
        } else if (format === 'mobi' || format === 'azw3' || format === 'azw' || format === 'prc') {
            Object.assign(context, await extractEpubLikeContent(book, mobiParser));
        } else if (format === 'fb2') {
            Object.assign(context, await extractEpubLikeContent(book, fb2Parser));
        } else if (format === 'pdf') {
            Object.assign(context, await extractPdfContent(book));
        } else {
            context.warnings.push(`当前格式 ${format || 'unknown'} 无法提取正文，仅能依据文件名与已有字段补全。`);
        }
    } catch (error) {
        context.warnings.push(`正文提取失败: ${error.message}`);
    }

    context.contentSample = context.contentSample.slice(0, 8000);
    return context;
}

function createMetadataSessionGuard() {
    const sessionMap = new Map();

    function pruneExpired() {
        const now = Date.now();
        for (const [key, value] of sessionMap.entries()) {
            if (!value || now - value.updatedAt > SESSION_TTL_MS) {
                sessionMap.delete(key);
            }
        }
    }

    function begin(sessionKey, bookId) {
        pruneExpired();
        const now = Date.now();
        const existing = sessionMap.get(sessionKey);

        if (existing && existing.bookId !== bookId) {
            const error = new Error('当前会话已锁定其他书籍，请开启新对话后再补全另一册。');
            error.code = 'SESSION_BOOK_LOCKED';
            throw error;
        }

        const next = {
            bookId,
            updatedAt: now,
            activeCount: (existing?.activeCount || 0) + 1
        };
        sessionMap.set(sessionKey, next);

        return () => {
            const current = sessionMap.get(sessionKey);
            if (!current || current.bookId !== bookId) {
                return;
            }
            current.activeCount = Math.max(0, current.activeCount - 1);
            current.updatedAt = Date.now();
            sessionMap.set(sessionKey, current);
        };
    }

    return {
        begin,
        getSession(sessionKey) {
            pruneExpired();
            return sessionMap.get(sessionKey) || null;
        },
        reset(sessionKey) {
            sessionMap.delete(sessionKey);
        }
    };
}

function buildMetadataSessionKey(userId, sessionId) {
    return `metadata:${userId}:${normalizeScalar(sessionId) || 'default'}`;
}

module.exports = {
    METADATA_FIELDS,
    isMetadataMissing,
    sanitizeCandidateValue,
    getMissingMetadataFields,
    mergeMetadataUpdates,
    extractBookMetadataContext,
    createMetadataSessionGuard,
    buildMetadataSessionKey
};
