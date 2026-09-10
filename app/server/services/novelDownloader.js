// 小说下载编排器
// 串联：书籍详情 → 目录 → 章节抓取 → EPUB/TXT 生成 → 落盘到用户选择的目录
// 落盘目录由路由层（novelDirs.resolveDownloadDir）校验并确保已被书库监听覆盖，
// 文件写入后由 watcher/scanQueue 自动扫描入库，本模块不直接操作 books 表。

const path = require('path');
const fs = require('fs');
const rules = require('./novelRulesLoader');
const crawler = require('./novelCrawler');
const { buildEpub, buildTxt, sanitizeFilename } = require('./novelEpubBuilder');
const progress = require('./novelProgressManager');
const dirs = require('./novelDirs');

// 启动一次下载
// params: { sourceId, bookUrl, bookName, extname='epub'|'txt', clientId, dir, userId }
// 返回 { taskId, dir, libraryId, libraryName }
async function startDownload(params) {
    const { sourceId, bookUrl, bookName = '', extname = 'epub', clientId, dir, userId, db } = params;
    const source = rules.getSourceById(sourceId);
    if (!source) throw new Error(`书源 ${sourceId} 不存在`);

    // 解析下载目录：默认 UPLOAD_DIR；自选目录经白名单校验并确保归属书库
    const resolved = await dirs.resolveDownloadDir(db, userId ? { id: userId, role: params.userRole } : null, dir);
    const outputDir = resolved.dir;
    fs.mkdirSync(outputDir, { recursive: true });

    // 立即带上前端传入的书名，避免任务创建后、书籍信息抓取完成前显示「未命名书籍」
    const task = progress.createTask(clientId, { bookName: bookName || '', userId });
    progress.updateTask(task.taskId, {
        dir: outputDir,
        libraryId: resolved.libraryId,
        libraryName: resolved.libraryName,
    });

    // 异步执行下载流程
    runDownload(task.taskId, source, bookUrl, extname, outputDir, clientId, resolved).catch(err => {
        // 在途请求被 abort 时抛出的是普通网络错误，用 isCancelled 兜底识别用户取消
        if (err instanceof progress.TaskCancelled || progress.isCancelled(task.taskId)) {
            progress.markCancelled(task.taskId);
        } else {
            progress.failTask(task.taskId, err);
        }
    });

    return {
        taskId: task.taskId,
        dir: outputDir,
        libraryId: resolved.libraryId,
        libraryName: resolved.libraryName,
        libraryCreated: resolved.libraryCreated,
    };
}

async function runDownload(taskId, source, bookUrl, extname, outputDir, clientId, resolved) {
    const signal = progress.getSignal(taskId);

    await progress.gate(taskId);
    // 1. 获取书籍详情
    progress.updateTask(taskId, { status: 'running', phase: 'fetching-book', message: '获取书籍信息中...' });
    const { info, doc, finalUrl } = await crawler.fetchBookInfo(source, bookUrl, signal);
    progress.updateTask(taskId, { bookName: info.bookName, message: `《${info.bookName}》信息已获取` });

    await progress.gate(taskId);
    // 2. 获取目录
    progress.updateTask(taskId, { phase: 'fetching-toc', message: '获取目录中...' });
    const chapters = await crawler.fetchToc(source, info, doc, bookUrl, signal);
    if (chapters.length === 0) throw new Error('未获取到章节目录');
    progress.updateTask(taskId, {
        total: chapters.length,
        phase: 'fetching-chapters',
        message: `共 ${chapters.length} 章，开始抓取正文...`,
    });

    await progress.gate(taskId);
    // 3. 抓取章节正文（带限流）
    const crawlCfg = rules.getCrawlConfig(source.id);
    const contents = [];
    const concurrency = Math.max(1, Math.min(crawlCfg.threads, 4));
    let completed = 0;

    // 分批并发
    const queue = chapters.slice();
    while (queue.length > 0) {
        await progress.gate(taskId); // 暂停时在这里等待，取消时在这里抛出
        const batch = queue.splice(0, concurrency);
        const results = await Promise.allSettled(batch.map(ch => crawler.fetchChapter(source, ch, source.chapter, signal)));
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (r.status === 'fulfilled') {
                contents.push(r.value);
            } else {
                contents.push({ title: batch[i]?.title || '未知章节', content: '[抓取失败]' });
            }
            completed++;
            progress.updateTask(taskId, {
                current: completed,
                phase: 'fetching-chapters',
                message: `抓取 ${completed}/${chapters.length}`,
            });
        }
        // 取消时不必再限流等待，直接进入下一轮 gate 抛错
        if (progress.isCancelled(taskId)) {
            await progress.gate(taskId);
        }
        // 限流等待
        await sleep(randInt(crawlCfg.minInterval, crawlCfg.maxInterval));
    }

    await progress.gate(taskId);

    // 4. 生成 EPUB / TXT
    progress.updateTask(taskId, { phase: 'building', message: '正在生成电子书文件...' });
    const onProgress = (p) => progress.updateTask(taskId, { phase: 'building', message: `生成中 ${p.current}/${p.total}` });

    let outPath;
    if (extname === 'txt') {
        outPath = await buildTxt(info, contents, { outputDir, onProgress });
    } else {
        try {
            outPath = await buildEpub(info, contents, { outputDir, onProgress });
        } catch (e) {
            console.warn('[NovelDownloader] EPUB 生成失败，回退 TXT:', e.message);
            outPath = await buildTxt(info, contents, { outputDir, onProgress });
        }
    }

    // 5. 完成（落盘目录的文件监听会自动把书扫描进书库）
    progress.completeTask(taskId, {
        filePath: outPath,
        fileName: path.basename(outPath),
        fileSize: fs.statSync(outPath).size,
        chapterCount: contents.length,
        bookName: info.bookName,
        author: info.author,
        dir: outputDir,
        libraryId: resolved.libraryId || null,
        libraryName: resolved.libraryName || null,
    });
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

module.exports = { startDownload };
