/**
 * TXT/MD 格式解析器 (增强版)
 * 支持多种章节格式、段落缩进、空行分段、防误匹配、1.2. 纯数字章节格式
 */
const fs = require('fs');
const readline = require('readline');
const iconv = require('iconv-lite');
const { detectEncoding, createDecodingStream, readFileWithEncoding } = require('../utils/encoding');
const { createLRUCache, getFileCacheKey } = require('../utils/lruCache');

const txtChapterCache = createLRUCache(80);

// 优化后的章节匹配规则（去重、增强容错、精准防误）
const CHAPTER_PATTERNS = [
    // 1. 核心常规：中文带编号章节/分卷（行首版本）
    // 优化：对"部、节、篇"等易混淆单位增加分隔符/结尾校验，且支持"部分"双字单位，防止"第一部分和..."被误判
    /^[\s　]*第[0-9零一二三四五六七八九十百千万〇]{1,8}(?:[章回卷集幕]|(?:部分|[节部篇])(?=[\s　：:.(（]|$))/,
    // 1b. 带前缀的章节：支持 "书名 第X章 标题" 或 "XX卷 第X章 标题" 格式（无行尾限制，支持后跟正文）
    /^[\s　]*.{1,20}\s+第[0-9零一二三四五六七八九十百千万〇]{1,8}[章回节篇幕]/,
    // 2. 简化格式：中文无"第"字编号分卷/章节（补充罗马数字，支持上中下卷）
    /^[\s　]*(?:卷[0-9零一二三四五六七八九十百千万〇IVXLCDMivxlcdm]{1,6}|[上中下]卷|\d{1,4}[章回节篇幕])/,
    // 3. 特殊章节：无编号辅助章节（补充英文对应标识，大小写不敏感）
    /^[\s　]*(?:序[章言曲幕]?|楔子|引[子言]|前[言传]|后[记传]|尾声|终章|番外|外传|特别篇|间章|幕间|Prologue|Epilogue|Introduction|Preface|Foreword|Afterword|Conclusion)/i,
    // 4. 英文常规：章节（Chapter/Section/Act，兼容数字/罗马数字，支持分隔符）
    /^[\s]*(Chapter|Section|Act)\s+([0-9]+|[IVXLCDMivxlcdm]{1,6})/i,
    // 5. 英文分卷：Volume/Book/Part（兼容数字/罗马数字/英文数字）
    /^[\s]*(Volume|Book|Part)\s+([0-9]+|[IVXLCDMivxlcdm]{1,6}|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten)/i,
    // 6. 正文关联：带"正文"前缀的章节
    /^[\s　]*正文\s+第[0-9零一二三四五六七八九十百千万〇]{1,8}[章回]/
    // 已删除：纯数字点号格式（如 "1. xxx"），因为容易误匹配正文列表内容
];

const MARKDOWN_HEADING_PATTERN = /^#{1,6}\s+.+$/;
const CHARS_PER_PAGE = 5000;
const DEFAULT_CHAPTER_LIMIT = 2000;
const PARAGRAPH_INDENT = 2;

/**
 * 优化后的章节标题判断函数（增强防误匹配，提升精准度）
 * @param {string} line - 待判断的文本行
 * @param {string} format - 文件格式（txt/md）
 * @returns {boolean} 是否为章节标题
 */
function isChapterTitle(line, format = 'txt') {
    const trimmed = line.trim();
    // 1. 空行直接排除
    if (trimmed.length === 0) return false;

    // 2. MD格式标题直接匹配
    if (format === 'md' && MARKDOWN_HEADING_PATTERN.test(line)) return true;

    // 3. 对于超长行（章节标题后可能直接跟正文），截取前80字符进行匹配
    //    例如："变脸之初卷 第一章 武士和处男　　罗迪一向是..."
    const checkText = trimmed.length > 80 ? trimmed.slice(0, 80) : trimmed;

    // 4. 遍历优化后的章节规则进行匹配
    for (const pattern of CHAPTER_PATTERNS) {
        if (pattern.test(checkText)) return true;
    }
    return false;
}

/**
 * 从行中提取简洁的章节标题（去除正文内容、日期时间等）
 * @param {string} line - 原始行内容
 * @returns {string} 提取的章节标题
 */
function extractChapterTitle(line) {
    const trimmed = line.trim();

    // 1. 尝试匹配 "第X章/回/节 标题" 格式，提取到标题部分
    // 标题部分允许包含括号、数字（如 "重生（1）"）
    const chapterMatch = trimmed.match(/^(.{0,20}?\s*)?(第[0-9零一二三四五六七八九十百千万〇]{1,8}[章回节篇幕卷集部])[\s:：·.]*(.{1,30})?/);
    if (chapterMatch) {
        const prefix = chapterMatch[1] ? chapterMatch[1].trim() : ''; // 书名/卷名前缀
        const chapter = chapterMatch[2]; // 第X章
        let title = chapterMatch[3] ? chapterMatch[3].trim() : ''; // 章节标题

        // 过滤掉明显的正文内容（如日期时间、长句子）
        // 如果标题超过20字符且包含句号/逗号，可能是正文，截断
        if (title.length > 15 && /[。，,.：:]/.test(title)) {
            const stopIdx = title.search(/[。，,.：:]/);
            if (stopIdx > 0) title = title.slice(0, stopIdx);
        }

        // 组合：前缀 + 章节 + 标题（限制总长度）
        let result = prefix ? `${prefix} ${chapter}` : chapter;
        if (title) result += ` ${title}`;
        return result.slice(0, 50);
    }

    // 2. 尝试匹配特殊章节（序章、楔子等）
    const specialMatch = trimmed.match(/^(序[章言曲幕]?|楔子|引[子言]|前[言传]|后[记传]|尾声|终章|番外|外传|特别篇|间章|幕间)/);
    if (specialMatch) {
        return specialMatch[1];
    }

    // 3. 尝试匹配英文章节
    const englishMatch = trimmed.match(/^(Chapter|Section|Part|Volume|Book|Act)\s+(\d+|[IVXLC]+)[\s:：·.-]*(.{0,30})?/i);
    if (englishMatch) {
        let result = `${englishMatch[1]} ${englishMatch[2]}`;
        if (englishMatch[3]) result += ` ${englishMatch[3].trim()}`;
        return result.slice(0, 50);
    }

    // 4. 默认：截取前50字符
    return trimmed.slice(0, 50);
}

// 优化：合并正则时排除修饰符冲突，仅保留必要的/i（全局大小写不敏感）
const CHAPTER_REGEX = new RegExp(
    CHAPTER_PATTERNS.map(p => p.source).join('|'),
    'i'
);

/**
 * HTML转义函数（完善转义规则，避免XSS风险）
 * @param {string} text - 待转义的文本
 * @returns {string} 转义后的HTML文本
 */
function escapeHtml(text) {
    if (typeof text !== 'string') return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
        .replace(/`/g, '&#96;')
        .replace(/\//g, '&#47;');
}

/**
 * 文本转HTML格式（优化段落逻辑，防空内容，增强排版兼容性）
 * @param {string} text - 原始文本
 * @param {object} options - 配置项
 * @returns {string} 格式化后的HTML
 */
function formatTextToHtml(text, options = {}) {
    const {
        indent = PARAGRAPH_INDENT,
        lineBreakAsP = true,
        emptyLineAsBreak = true
    } = options;
    const lines = text.split('\n');
    const paragraphs = [];

    for (const line of lines) {
        const trimmed = line.trim();
        // 空行处理：避免连续空段落
        if (trimmed.length === 0) {
            if (emptyLineAsBreak && paragraphs[paragraphs.length - 1] !== '<br>') {
                paragraphs.push('<br>');
            }
            continue;
        }

        const isDialogue = /^["'"「『【]/.test(trimmed);
        const isTitle = isChapterTitle(trimmed);

        // 章节标题：居中样式优化，避免重复包裹
        if (isTitle) {
            const escapedTitle = escapeHtml(trimmed);
            paragraphs.push(`<h3 class="chapter-title">${escapedTitle}</h3>`);
        }
        // 普通段落：防缩进滥用（对话不缩进），优化行高
        else if (lineBreakAsP) {
            const indentStyle = (!isDialogue && indent > 0)
                ? `text-indent: ${indent}em; line-height: 1.8;`
                : 'line-height: 1.8;';
            const escapedContent = escapeHtml(trimmed);
            paragraphs.push(`<p style="${indentStyle}">${escapedContent}</p>`);
        }
    }

    // 过滤空内容，去重连续<br>
    return paragraphs
        .filter(p => p !== '' && p !== '<br>')
        .join('\n');
}

/**
 * Markdown转HTML格式（优化匹配逻辑，防空内容，增强排版一致性）
 * @param {string} text - 原始Markdown文本
 * @returns {string} 格式化后的HTML
 */
function formatMarkdownToHtml(text) {
    if (typeof text !== 'string') return '';
    let html = text;

    // MD标题转换（优化全局匹配，避免行内误匹配）
    html = html.replace(/^#{6}\s+(.+)$/gm, '<h6 class="md-heading">$1</h6>');
    html = html.replace(/^#{5}\s+(.+)$/gm, '<h5 class="md-heading">$1</h5>');
    html = html.replace(/^#{4}\s+(.+)$/gm, '<h4 class="md-heading">$1</h4>');
    html = html.replace(/^#{3}\s+(.+)$/gm, '<h3 class="md-heading chapter-title">$1</h3>');
    html = html.replace(/^#{2}\s+(.+)$/gm, '<h2 class="md-heading">$1</h2>');
    html = html.replace(/^#{1}\s+(.+)$/gm, '<h1 class="md-heading">$1</h1>');

    // MD格式转换（完善样式，避免空内容）
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    html = html.replace(/^[-*_]{3,}$/gm, '<hr class="md-hr">');

    // 段落处理：优化普通文本排版，防连续空标签
    const lines = html.split('\n');
    return lines
        .map(line => {
            const trimmed = line.trim();
            if (trimmed === '') return '';
            if (trimmed.startsWith('<') || trimmed.startsWith('</')) return line;
            return `<p style="text-indent: 2em; line-height: 1.8;">${trimmed}</p>`;
        })
        .filter(line => line !== '')
        .join('\n');
}

/**
 * 解析目录（优化进度计算，防重复Toc，增强流响应稳定性）
 * @param {object} params - 配置参数
 * @returns {object|null} 目录结果或流响应
 */
async function parseToc({ book, isStream, coverUrl, res, mtime }) {
    const toc = [];
    const totalBytes = book.size || fs.statSync(book.filepath).size; // 兼容无size属性的book对象
    const encoding = detectEncoding(book.filepath);
    const format = book.format || 'txt';

    const rawFileStream = fs.createReadStream(book.filepath);
    const fileStream = rawFileStream.pipe(iconv.decodeStream(encoding));
    
    // 手动处理底层错误，转发到解码流（修复 EIO 崩溃问题）
    rawFileStream.on('error', (err) => {
        // fileStream 是 pipe 后的流，这里我们需要确保错误能被外层 try-catch 捕获
        // 但由于是异步流，try-catch 无法捕获，所以需要在流上触发 error
        fileStream.emit('error', err);
    });

    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    // 流响应配置：增强头部稳定性，防连接断开
    if (isStream && res) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-store');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // 禁用nginx缓冲
    }

    let lineIndex = 0, lastProgress = 0, currentChars = 0;
    let nextBreakPoint = CHARS_PER_PAGE, autoPageCount = 1;
    const autoToc = [{ title: '开始', line: 0 }];

    try {
        for await (const line of rl) {
            currentChars += line.length + 1;

            // 章节标题匹配：去重空白，限制长度，防重复添加
            if (isChapterTitle(line, format)) {
                let title = line.trim();
                if (format === 'md') title = title.replace(/^#+\s*/, '');
                // 使用智能提取函数获取简洁的章节标题
                const shortTitle = extractChapterTitle(title);
                // 避免添加重复目录项
                if (!toc.some(item => item.title === shortTitle)) {
                    toc.push({ title: shortTitle, line: lineIndex });
                }
            }

            // 自动分页：防重复分页，优化断点计算
            if (currentChars >= nextBreakPoint) {
                autoPageCount++;
                const pageTitle = `第${autoPageCount}页`;
                if (!autoToc.some(item => item.title === pageTitle)) {
                    autoToc.push({ title: pageTitle, line: lineIndex + 1 });
                }
                nextBreakPoint += CHARS_PER_PAGE;
            }

            // 进度推送：防频繁推送，优化精度
            if (isStream && res) {
                const progress = Math.min(Math.round((rawFileStream.bytesRead / totalBytes) * 100), 99);
                if (progress > lastProgress + 2) { // 每2%推送一次，减少压力
                    res.write(`data: ${JSON.stringify({
                        type: 'progress',
                        percent: progress,
                        message: '解析目录中...'
                    })}\n\n`);
                    lastProgress = progress;
                }
            }
            lineIndex++;
        }
    } catch (err) {
        console.error('解析目录失败：', err);
        if (isStream && res) {
            res.write(`data: ${JSON.stringify({ type: 'error', message: '解析目录失败' })}\n\n`);
            res.end();
        }
        return null;
    }

    // 最终目录处理：优先自定义Toc，补充起始项（优化判断逻辑）
    let finalToc = toc.length > 0 ? toc : autoToc;
    if (toc.length > 0 && finalToc[0]?.line > 10) {
        finalToc.unshift({ title: '开始', line: 0 });
    }

    const response = {
        type: 'complete',
        toc: finalToc,
        total_lines: lineIndex,
        total_chars: currentChars,
        title: book.title || '未知小说',
        format,
        in_bookshelf: book.in_bookshelf || false,
        cover: coverUrl || '',
        mtime: mtime || 0
    };

    if (isStream && res) {
        res.write(`data: ${JSON.stringify(response)}\n\n`);
        res.end();
        return null;
    }
    return response;
}

/**
 * 加载章节内容（优化读取逻辑，防内存溢出，增强兼容性）
 * @param {object} params - 配置参数
 * @returns {object} 章节内容结果
 */
async function loadChapter({ book, startLine = 0, endLine = -1, limit = DEFAULT_CHAPTER_LIMIT, format: outputFormat = 'html' }) {
    if (!book?.filepath) {
        return { content: '', format: outputFormat, lines: 0, error: '缺少文件路径' };
    }

    const cacheKey = getFileCacheKey(book.filepath, `txt-ch-${startLine}-${endLine}-${limit}-${outputFormat}`);
    const cached = txtChapterCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const encoding = detectEncoding(book.filepath);
    const fileStream = createDecodingStream(book.filepath, encoding);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    const bookFormat = book.format || 'txt';

    let currentLine = 0, rawContent = "", linesRead = 0;

    try {
        for await (const line of rl) {
            if (currentLine >= startLine) {
                // 终止条件：达到结束行或读取限制
                if ((endLine !== -1 && currentLine >= endLine) || (endLine === -1 && linesRead >= limit)) {
                    break;
                }
                rawContent += line + '\n';
                linesRead++;
            }
            currentLine++;
        }
    } catch (err) {
        console.error('加载章节失败：', err);
        const errorMsg = (err.code === 'EIO' || err.code === 'EACCES' || err.code === 'EPERM') 
            ? '当前文件没有读取权限，请检查' 
            : '加载章节失败';
        return { content: '', format: outputFormat, lines: 0, error: errorMsg };
    }

    // 格式转换：优化HTML样式，增强容错
    let result;
    if (outputFormat === 'html') {
        let htmlContent = bookFormat === 'md'
            ? formatMarkdownToHtml(rawContent)
            : formatTextToHtml(rawContent, { indent: PARAGRAPH_INDENT, lineBreakAsP: true });
        const styledContent = `<style>
            .chapter-content { max-width: 800px; margin: 0 auto; padding: 0 20px; }
            .chapter-content p { margin: 0.5em 0; line-height: 1.8; }
            .chapter-content .chapter-title { text-align: center; margin: 1em 0; font-weight: bold; font-size: 1.2em; }
            .chapter-content .md-hr { margin: 1em 0; border: 0; border-top: 1px solid #eee; }
        </style><div class="chapter-content">${htmlContent}</div>`;
        result = { content: styledContent, format: 'html', lines: linesRead };
    } else {
        result = { content: rawContent, format: 'text', lines: linesRead };
    }

    txtChapterCache.set(cacheKey, result);
    return result;
}

/**
 * 加载完整内容（优化编码处理，防空内容）
 * @param {object} book - 书籍对象
 * @returns {object} 完整内容结果
 */
function loadContent({ book }) {
    if (!book?.filepath) {
        return { type: 'error', content: '', rawContent: '', encoding: '', title: '未知小说', error: '缺少文件路径' };
    }

    const { content, encoding } = readFileWithEncoding(book.filepath);
    const format = book.format || 'txt';
    const htmlContent = format === 'md'
        ? formatMarkdownToHtml(content)
        : formatTextToHtml(content, { indent: PARAGRAPH_INDENT, lineBreakAsP: true });

    return {
        type: 'text',
        content: htmlContent,
        rawContent: content || '',
        encoding,
        title: book.title || '未知小说'
    };
}

/**
 * 获取支持的文件格式（返回数组，便于扩展）
 * @returns {array} 支持的格式列表
 */
function getSupportedFormats() {
    return ['txt', 'md'];
}

module.exports = {
    parseToc, loadChapter, loadContent, getSupportedFormats,
    CHAPTER_PATTERNS, CHAPTER_REGEX, MARKDOWN_HEADING_PATTERN,
    CHARS_PER_PAGE, DEFAULT_CHAPTER_LIMIT, PARAGRAPH_INDENT,
    isChapterTitle, formatTextToHtml, formatMarkdownToHtml, escapeHtml
};