/**
 * PDF 格式处理器
 * 提供 PDF 流式传输和预览功能
 */
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');

/**
 * 流式传输 PDF 文件
 */
function streamPdf({ book, req, res }) {
    try {
        if (!fs.existsSync(book.filepath)) {
            console.error(`File not found: ${book.filepath}`);
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('File not found');
            return;
        }

        const stat = fs.statSync(book.filepath);
        const fileSize = stat.size;
        const lastModified = stat.mtime ? stat.mtime.toUTCString() : new Date().toUTCString();

        const rawFileName = path.basename(book.filepath || 'document.pdf');
        const encodedFileName = encodeURIComponent(rawFileName);

        // 统一基础响应头（声明支持分块 Range 与缓存，明确 inline 指令防止浏览器强制下载）
        const commonHeaders = {
            'Accept-Ranges': 'bytes',
            'Content-Type': 'application/pdf',
            'Content-Disposition': `inline; filename="${encodedFileName}"; filename*=UTF-8''${encodedFileName}`,
            'Cache-Control': 'public, max-age=86400',
            'Last-Modified': lastModified,
        };

        // 处理 HEAD 预检请求（仅返回头信息，不发送实体）
        if (req.method === 'HEAD') {
            res.writeHead(200, {
                ...commonHeaders,
                'Content-Length': fileSize,
            });
            res.end();
            return;
        }

        const range = req.headers.range;

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const rawEnd = parts[1] ? parseInt(parts[1], 10) : NaN;

            // 范围校验：若 start 超出文件大小或 start > end，返回 416
            if (isNaN(start) || start < 0 || start >= fileSize || (!isNaN(rawEnd) && start > rawEnd)) {
                res.writeHead(416, {
                    'Content-Range': `bytes */${fileSize}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Type': 'text/plain',
                });
                res.end('Requested range not satisfiable');
                return;
            }

            const end = !isNaN(rawEnd) ? Math.min(rawEnd, fileSize - 1) : fileSize - 1;
            const chunksize = (end - start) + 1;
            const file = fs.createReadStream(book.filepath, { start, end });

            file.on('error', (err) => {
                console.error('Stream error:', err);
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Stream error');
                }
            });

            res.writeHead(206, {
                ...commonHeaders,
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Content-Length': chunksize,
            });
            file.pipe(res);
        } else {
            const file = fs.createReadStream(book.filepath);

            file.on('error', (err) => {
                console.error('Stream error:', err);
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Stream error');
                }
            });

            res.writeHead(200, {
                ...commonHeaders,
                'Content-Length': fileSize,
            });
            file.pipe(res);
        }
    } catch (err) {
        console.error('PDF stream error:', err);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal Server Error');
        }
    }
}

/**
 * 加载 PDF 内容（返回嵌入式查看器）
 */
function loadContent({ book, bookId }) {
    return {
        type: 'pdf',
        content: `<iframe src="/api/books/${bookId}/pdf_stream" style="width:100%;height:100%;border:none;"></iframe>`,
        title: book.title,
        format: 'pdf'
    };
}

/**
 * 获取支持的格式列表
 */
function getSupportedFormats() {
    return ['pdf'];
}

module.exports = {
    streamPdf,
    loadContent,
    getSupportedFormats
};
