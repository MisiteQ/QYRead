// 小说 EPUB/TXT 生成器
// TXT: 直接拼接章节输出
// EPUB: 复用项目已有的 utils/txtToEpub.js（基于 AdmZip 从零构建标准 EPUB）

const path = require('path');
const fs = require('fs');
const os = require('os');
const { convertTxtToEpub } = require('../utils/txtToEpub');

// 生成 EPUB
// bookInfo: { bookName, author, intro, coverUrl?, category }
// chapters: [{ title, content }]
// options: { outputDir, onProgress }
async function buildEpub(bookInfo, chapters, options = {}) {
    const { outputDir, onProgress } = options;
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const safeName = sanitizeFilename(bookInfo.bookName || 'novel');
    const outPath = path.join(outputDir, `${safeName}.epub`);

    // 先生成临时 TXT（用「第N章 标题」格式，便于 txtToEpub 识别章节边界）
    const tmpDir = path.join(os.tmpdir(), 'qyread-novel');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const tmpTxt = path.join(tmpDir, `${safeName}-${Date.now()}.txt`);

    const parts = [];
    if (bookInfo.intro) {
        parts.push(bookInfo.intro);
        parts.push('');
    }
    let idx = 0;
    for (const ch of chapters) {
        idx++;
        if (onProgress && idx % 5 === 0) {
            onProgress({ current: idx, total: chapters.length, phase: 'building' });
        }
        // 章节标题格式：若原标题已是「第X章」格式则保留，否则补「第N章」前缀
        let title = ch.title || `第${idx}章`;
        if (!/^第[一二三四五六七八九十百千万零\d]+[章节回卷]/.test(title)) {
            title = `第${idx}章 ${title}`;
        }
        parts.push(title);
        parts.push('');
        parts.push(ch.content || '');
        parts.push('');
        parts.push('');
    }
    fs.writeFileSync(tmpTxt, '\uFEFF' + parts.join('\n'), 'utf8');

    try {
        // 调用项目已有的转换器：convertTxtToEpub(txtPath, epubPath, title, author, encoding)
        convertTxtToEpub(tmpTxt, outPath, bookInfo.bookName || '未命名', bookInfo.author || '未知', 'utf-8');
        if (onProgress) onProgress({ current: chapters.length, total: chapters.length, phase: 'done' });
        return outPath;
    } catch (e) {
        throw new Error(`EPUB 生成失败: ${e.message}`);
    } finally {
        try { fs.unlinkSync(tmpTxt); } catch {}
    }
}

// 生成 TXT
async function buildTxt(bookInfo, chapters, options = {}) {
    const { outputDir, onProgress } = options;
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const safeName = sanitizeFilename(bookInfo.bookName || 'novel');
    const outPath = path.join(outputDir, `${safeName}.txt`);

    const parts = [];
    if (bookInfo.bookName) parts.push(bookInfo.bookName);
    if (bookInfo.author) parts.push(`作者: ${bookInfo.author}`);
    parts.push('');
    if (bookInfo.intro) {
        parts.push(bookInfo.intro);
        parts.push('');
    }
    parts.push('====================================');
    parts.push('');

    let count = 0;
    for (const ch of chapters) {
        count++;
        parts.push(ch.title || `第${count}章`);
        parts.push('');
        parts.push(ch.content || '');
        parts.push('');
        parts.push('');
        if (onProgress && count % 5 === 0) {
            onProgress({ current: count, total: chapters.length, phase: 'building' });
        }
    }

    const text = parts.join('\n');
    fs.writeFileSync(outPath, '\uFEFF' + text, 'utf8');
    if (onProgress) onProgress({ current: chapters.length, total: chapters.length, phase: 'done' });
    return outPath;
}

function sanitizeFilename(name) {
    return String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 100);
}

module.exports = { buildEpub, buildTxt, sanitizeFilename };
