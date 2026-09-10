// 小说下载进度管理
// 使用 SSE (Server-Sent Events) 向客户端推送下载进度
// 每个下载任务以 clientId 关联，支持多客户端各自订阅
// 支持任务暂停 / 继续 / 取消（协作式：下载器在批次边界检查）

const crypto = require('crypto');

// 活跃下载任务表
const tasks = new Map(); // taskId -> 纯数据任务对象（会被 SSE 序列化，勿放控制器）

// taskId -> 运行时控制对象（不对外序列化）
// { abort: AbortController, paused: boolean, cancelled: boolean,
//   resumeWaiters: Function[] }
const controls = new Map();

// clientId -> response 流（SSE 连接）
const clients = new Map();

// 注册 SSE 客户端
function addClient(clientId, res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ clientId, time: Date.now() })}\n\n`);

    clients.set(clientId, res);

    // 心跳
    const ping = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { clearInterval(ping); }
    }, 25000);

    res.on('close', () => {
        clearInterval(ping);
        clients.delete(clientId);
    });

    return clientId;
}

// 向某客户端推送事件
function emit(clientId, event, data) {
    const res = clients.get(clientId);
    if (!res || res.destroyed) return;
    try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
        // 连接已断
    }
}

// 已终结任务保留时长（24 小时），便于客户端刷新页面后恢复显示
const FINISHED_TTL = 24 * 60 * 60 * 1000;
// 活跃任务心跳超时：超过该时长没有任何进度更新，视为卡死（书源无响应等），自动标记失败
const ACTIVE_STALE_MS = 15 * 60 * 1000;
// 起步阶段（还没有书名、尚未进入章节抓取）卡死超时：书源无响应时快速失败，避免幽灵任务
const INIT_STALE_MS = 60 * 1000;

function cleanupTasks() {
    const now = Date.now();
    for (const [id, t] of tasks) {
        const finished = t.status === 'done' || t.status === 'error' || t.status === 'cancelled';
        if (finished) {
            if ((now - (t.endTime || t.startTime)) > FINISHED_TTL) {
                tasks.delete(id);
                controls.delete(id);
            }
            continue;
        }
        // 暂停中的任务不计时
        if (t.status === 'paused') continue;
        const lastBeat = t.lastUpdate || t.startTime || now;
        const inInitPhase = !t.bookName || t.phase === 'init' || t.phase === 'fetching-book' || t.phase === 'fetching-toc';
        if (inInitPhase && now - lastBeat > INIT_STALE_MS) {
            t.endTime = now;
            t.status = 'error';
            t.error = '获取书籍信息超时（书源可能无法访问），已自动取消';
            t.lastUpdate = now;
            const c = controls.get(id);
            if (c) try { c.abort.abort(); } catch {}
            emit(t.clientId, 'progress', t);
            emit(t.clientId, 'error', t);
            continue;
        }
        // 活跃任务：长时间无心跳（初始化后从未更新过也算），标记失败并通知前端
        if (now - lastBeat > ACTIVE_STALE_MS) {
            t.endTime = now;
            t.status = 'error';
            t.error = '任务超时：长时间没有下载进度（书源可能无法访问），已自动取消';
            t.lastUpdate = now;
            const c = controls.get(id);
            if (c) try { c.abort.abort(); } catch {}
            emit(t.clientId, 'progress', t);
            emit(t.clientId, 'error', t);
        }
    }
}
// 定时巡检：让超时自动失败即使没有新任务/SSE 连接也能推送出去
const cleanupTimer = setInterval(() => { try { cleanupTasks(); } catch {} }, 15000);
if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref(); // 不阻止进程退出

// 创建下载任务
function createTask(clientId, bookInfo) {
    cleanupTasks();
    const taskId = crypto.randomUUID();
    const task = {
        taskId,
        clientId,
        userId: bookInfo.userId || null,
        bookName: bookInfo.bookName,
        status: 'pending', // pending / running / paused / done / error / cancelled
        current: 0,
        total: 0,
        phase: 'init',
        message: '',
        result: null,
        error: null,
        startTime: Date.now(),
        endTime: null,
        lastUpdate: Date.now(),
    };
    tasks.set(taskId, task);
    controls.set(taskId, {
        abort: new AbortController(),
        paused: false,
        cancelled: false,
        resumeWaiters: [],
    });
    return task;
}
// 更新任务进度并推送
function updateTask(taskId, patch) {
    const task = tasks.get(taskId);
    if (!task) return;
    Object.assign(task, patch);
    task.lastUpdate = Date.now();
    emit(task.clientId, 'progress', task);
}

// 任务完成
function completeTask(taskId, result) {
    const task = tasks.get(taskId);
    if (!task) return;
    task.endTime = Date.now();
    task.status = 'done';
    task.phase = 'finished';
    task.result = result;
    controls.delete(taskId);
    emit(task.clientId, 'progress', task);
    emit(task.clientId, 'complete', task);
}

// 任务失败
function failTask(taskId, error) {
    const task = tasks.get(taskId);
    if (!task) return;
    task.endTime = Date.now();
    task.status = 'error';
    task.error = error && error.message ? error.message : String(error);
    controls.delete(taskId);
    emit(task.clientId, 'progress', task);
    emit(task.clientId, 'error', task);
}

// ============ 暂停 / 继续 / 取消 ============

function isCancelled(taskId) {
    const c = controls.get(taskId);
    return !!(c && c.cancelled);
}

// 下载器在阶段/批次边界调用：暂停时等待，取消时抛错
async function gate(taskId) {
    const task = tasks.get(taskId);
    const c = controls.get(taskId);
    if (!task || !c) return;
    if (c.cancelled) throw new TaskCancelled('任务已取消');
    if (!c.paused) return;
    await new Promise(resolve => c.resumeWaiters.push(resolve));
    if (c.cancelled) throw new TaskCancelled('任务已取消');
}

function pauseTask(taskId) {
    const task = tasks.get(taskId);
    const c = controls.get(taskId);
    if (!task || !c) return false;
    if (task.status === 'done' || task.status === 'error' || task.status === 'cancelled') return false;
    c.paused = true;
    task.status = 'paused';
    task.lastUpdate = Date.now();
    emit(task.clientId, 'progress', task);
    return true;
}

function resumeTask(taskId) {
    const task = tasks.get(taskId);
    const c = controls.get(taskId);
    if (!task || !c) return false;
    if (!c.paused && task.status !== 'paused') return false;
    c.paused = false;
    task.status = 'running';
    task.lastUpdate = Date.now();
    const waiters = c.resumeWaiters.splice(0);
    waiters.forEach(fn => { try { fn(); } catch {} });
    emit(task.clientId, 'progress', task);
    return true;
}

// 请求取消：立即中断在途 HTTP，已暂停的也唤醒；最终状态由下载器落定
function requestCancel(taskId) {
    const task = tasks.get(taskId);
    const c = controls.get(taskId);
    if (!task || !c) return false;
    if (task.status === 'done' || task.status === 'error' || task.status === 'cancelled') return false;
    c.cancelled = true;
    c.paused = false;
    task.status = 'cancelling';
    task.message = '正在取消...';
    task.lastUpdate = Date.now();
    try { c.abort.abort(); } catch {}
    const waiters = c.resumeWaiters.splice(0);
    waiters.forEach(fn => { try { fn(); } catch {} });
    emit(task.clientId, 'progress', task);
    return true;
}

// 下载器感知到取消后落定状态
function markCancelled(taskId) {
    const task = tasks.get(taskId);
    if (!task) return;
    task.endTime = Date.now();
    task.status = 'cancelled';
    task.phase = 'cancelled';
    task.message = '已取消';
    controls.delete(taskId);
    emit(task.clientId, 'progress', task);
    emit(task.clientId, 'cancelled', task);
}

// 取任务取消信号（透传给爬虫 AbortSignal）
function getSignal(taskId) {
    const c = controls.get(taskId);
    return c ? c.abort.signal : undefined;
}

class TaskCancelled extends Error {
    constructor(message) {
        super(message || '任务已取消');
        this.name = 'TaskCancelled';
    }
}

function getTask(taskId) {
    return tasks.get(taskId);
}

function listTasks() {
    cleanupTasks();
    return Array.from(tasks.values());
}

// 列出某客户端最近的任务（含已终结，按开始时间倒序）
function listByClient(clientId, limit = 20) {
    cleanupTasks();
    return listTasks()
        .filter(t => t.clientId === clientId)
        .sort((a, b) => b.startTime - a.startTime)
        .slice(0, limit);
}

module.exports = {
    addClient,
    emit,
    createTask,
    updateTask,
    completeTask,
    failTask,
    pauseTask,
    resumeTask,
    requestCancel,
    markCancelled,
    isCancelled,
    gate,
    getSignal,
    TaskCancelled,
    getTask,
    listTasks,
    listByClient,
};
