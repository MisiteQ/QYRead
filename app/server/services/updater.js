// 惬意阅读 - 在线更新服务（参考 fnmonitor UpdateManager，移植到 Node.js）
// 基于 GitHub Releases：检查新版本、下载 fpk 到 NAS、解包覆盖安装、自我重启。
// 挂载到 /api/extra/update/*（由 routes/update.js 调用），无需改动混淆的 server.js。

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');

const UPDATE_REPO = 'MisiteQ/QYRead';
const UPDATE_CHECK_INTERVAL = 6 * 3600 * 1000;  // 6 小时
const GH_MIRRORS = ['', 'https://gh-proxy.com/', 'https://ghfast.top/', 'https://ghproxy.net/', 'https://gh.llkk.cc/'];

const PKGVAR = process.env.TRIM_PKGVAR || path.join(__dirname, '..', '..', '..');
const APPDEST = process.env.TRIM_APPDEST || path.join(__dirname, '..', '..');
const APPBASE = path.join(APPDEST, '..');  // /var/apps/{appname}（manifest / ICON / cmd 所在）
const DATA_DIR = process.env.DATA_DIR || PKGVAR;
const UPDATE_DIR = path.join(DATA_DIR, 'update');
const CONF_FILE = path.join(PKGVAR, 'update.conf');

// ---- 状态 ----
let _cache = null;            // 最近一次 check() 结果（30 分钟缓存）
let _lastCheck = 0;
let _status = {
    last_check: '', latest: '', has_update: false,
    downloading: false, downloaded_file: '', download_dir: '', error: ''
};
let _autoTimer = null;

// ---- 工具 ----
function log(msg) {
    try { console.log('[Updater] ' + msg); } catch (e) {}
}

function detectArch() {
    // Node process.arch: 'arm64' -> arm；'x64' / 其它 -> x86
    var a = String(process.arch || '').toLowerCase();
    return (a === 'arm64' || a.indexOf('arm') === 0) ? 'arm' : 'x86';
}

function manifestPath() {
    // fnOS 应用基础目录的 manifest（应用中心读这个）；开发期回退到仓库根
    var p = path.join(APPBASE, 'manifest');
    if (fs.existsSync(p)) return p;
    return path.join(__dirname, '..', '..', '..', 'manifest');
}

function getCurrentVersion() {
    try {
        var txt = fs.readFileSync(manifestPath(), 'utf8');
        var m = /version\s*=\s*([0-9][0-9A-Za-z.\-]*)/.exec(txt);
        if (m) return m[1];
    } catch (e) {}
    return '0.0.0';
}

// 'v2.9.0' / '2.9.0' -> [2,9,0]
function verTuple(v) {
    var m = String(v || '').match(/\d+/g);
    if (!m) return [0, 0, 0];
    return m.slice(0, 3).map(function (n) { return parseInt(n, 10) || 0; });
}
function isNewer(latest, current) {
    var a = verTuple(latest), b = verTuple(current);
    for (var i = 0; i < 3; i++) {
        if ((a[i] || 0) > (b[i] || 0)) return true;
        if ((a[i] || 0) < (b[i] || 0)) return false;
    }
    return false;
}

// HTTPS GET：返回 {statusCode, headers, body} 或对下载返回 stream
function httpsGet(url, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
        var req = https.get(url, {
            headers: opts.headers || {},
            timeout: opts.timeout || 30000
        }, function (res) {
            resolve(res);
        });
        req.on('error', reject);
        req.on('timeout', function () { req.destroy(new Error('timeout')); });
    });
}

// 打开 GitHub 下载地址：直连失败后自动尝试加速镜像
function ghOpen(url, timeout) {
    var lastErr = null;
    var mirrors = GH_MIRRORS.slice();
    return new Promise(function (resolve, reject) {
        function tryNext(i) {
            if (i >= mirrors.length) { reject(lastErr || new Error('all mirrors failed')); return; }
            var m = mirrors[i];
            var u = m ? (m + url) : url;
            httpsGet(u, { headers: { 'User-Agent': 'qyread-updater' }, timeout: timeout || 60 })
                .then(function (res) {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(res);
                    } else {
                        lastErr = new Error('HTTP ' + res.statusCode + ' @ ' + (m || 'direct'));
                        try { res.resume(); } catch (e) {}
                        tryNext(i + 1);
                    }
                })
                .catch(function (e) { lastErr = e; tryNext(i + 1); });
        }
        tryNext(0);
    });
}

// 读 body 到字符串
function readBody(res, maxLen) {
    return new Promise(function (resolve, reject) {
        var chunks = [], total = 0;
        res.on('data', function (c) {
            total += c.length;
            if (maxLen && total > maxLen) { res.destroy(); reject(new Error('response too large')); return; }
            chunks.push(c);
        });
        res.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
        res.on('error', reject);
    });
}

// ---- 配置 ----
function loadConfig() {
    try {
        var raw = fs.readFileSync(CONF_FILE, 'utf8');
        return JSON.parse(raw);
    } catch (e) {}
    return { autocheck: true, autoupdate: false };
}
function saveConfig(cfg) {
    try {
        fs.writeFileSync(CONF_FILE, JSON.stringify(cfg, null, 2));
    } catch (e) {}
}

// ---- 检查 ----
async function check(force) {
    if (!force && _cache && Date.now() - _lastCheck < 30 * 60 * 1000) {
        return Object.assign({}, _cache, { cached: true });
    }
    var arch = detectArch();
    var current = getCurrentVersion();
    var info = {
        ok: false, current_version: current, current: current, arch: arch,
        latest: '', latest_version: '', has_update: false, notes: '',
        published_at: '', html_url: 'https://github.com/' + UPDATE_REPO + '/releases/latest',
        asset: null, error: ''
    };
    try {
        var res = await httpsGet('https://api.github.com/repos/' + UPDATE_REPO + '/releases/latest', {
            headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'qyread-updater' },
            timeout: 15000
        });
        if (res.statusCode !== 200) {
            info.error = 'GitHub API HTTP ' + res.statusCode;
        } else {
            var body = await readBody(res, 1 << 20);
            var rel = JSON.parse(body);
            var latest = String(rel.tag_name || '').replace(/^[vV]/, '');
            info.ok = true;
            info.latest = latest;
            info.latest_version = latest;
            info.has_update = isNewer(latest, current);
            info.notes = String(rel.body || '').slice(0, 3000);
            info.published_at = String(rel.published_at || '');
            if (rel.html_url) info.html_url = rel.html_url;
            // 选当前架构的 fpk 资产
            var want = 'qyread-' + latest + '-' + arch + '.fpk';
            var assets = rel.assets || [];
            for (var i = 0; i < assets.length; i++) {
                if (String(assets[i].name) === want) {
                    info.asset = mkAsset(assets[i]);
                    break;
                }
            }
            if (!info.asset) {
                // 兜底：任一同平台包
                for (var j = 0; j < assets.length; j++) {
                    if (String(assets[j].name || '').endsWith('-' + arch + '.fpk')) {
                        info.asset = mkAsset(assets[j]);
                        break;
                    }
                }
            }
        }
    } catch (e) {
        info.error = String(e.message || e);
    }
    _cache = info;
    _lastCheck = Date.now();
    _status.error = info.error;
    if (info.ok) {
        _status.latest = info.latest;
        _status.has_update = info.has_update;
        _status.last_check = new Date().toISOString().replace('T', ' ').slice(0, 19);
    }
    return info;
}

function mkAsset(a) {
    return {
        name: a.name, size: parseInt(a.size, 10) || 0,
        download_url: a.browser_download_url,
        digest: String(a.digest || '').replace('sha256:', '')
    };
}

// ---- 下载到 NAS ----
async function downloadToNas(asset, destDir) {
    var name = (asset && asset.name) || 'qyread.fpk';
    var url = asset && asset.download_url;
    if (!url) return { success: false, error: '资产缺少下载地址' };
    var ddir = destDir || UPDATE_DIR;
    try { fs.mkdirSync(ddir, { recursive: true }); } catch (e) {}
    var final = path.join(ddir, name);
    var tmp = final + '.tmp';
    _status.downloading = true;
    try {
        var res = await ghOpen(url, 120000);
        await new Promise(function (resolve, reject) {
            var ws = fs.createWriteStream(tmp);
            res.pipe(ws);
            ws.on('finish', resolve);
            ws.on('error', reject);
            res.on('error', reject);
        });
        // SHA256 校验
        var expect = String((asset && asset.digest) || '').toLowerCase();
        if (expect) {
            var h = crypto.createHash('sha256');
            var fd = fs.openSync(tmp, 'r');
            var buf = Buffer.alloc(65536);
            var n;
            while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
                h.update(buf.slice(0, n));
            }
            fs.closeSync(fd);
            if (h.digest('hex') !== expect) {
                try { fs.unlinkSync(tmp); } catch (e) {}
                return { success: false, error: '安装包 SHA256 校验失败（下载不完整或被篡改），请重试' };
            }
        }
        fs.renameSync(tmp, final);
        if (!destDir) {
            _status.downloaded_file = final;
            _status.download_dir = ddir;
        }
        return { success: true, path: final, downloaded: true };
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch (err) {}
        return { success: false, error: String(e.message || e) };
    } finally {
        _status.downloading = false;
    }
}

function downloadedPath() {
    // 检查已下载的 fpk 是否还在
    var f = _status.downloaded_file;
    if (f && fs.existsSync(f)) return f;
    // 兜底：扫描 update 目录
    try {
        var arch = detectArch();
        var files = fs.readdirSync(UPDATE_DIR).filter(function (n) {
            return /qyread-.*-.*\.fpk$/.test(n) && n.indexOf('-' + arch + '.fpk') !== -1;
        });
        if (files.length) return path.join(UPDATE_DIR, files.sort().pop());
    } catch (e) {}
    return '';
}

// ---- 安装（解包 fpk 覆盖应用目录后自我重启） ----
async function installFpk(fpkPath) {
    var tmp = path.join(UPDATE_DIR, '_extract');
    try { execSync('rm -rf "' + tmp + '"', { stdio: 'ignore' }); } catch (e) {}
    try { fs.mkdirSync(tmp, { recursive: true }); } catch (e) {}
    try {
        // fpk 结构：app.tgz + cmd/ + manifest，平铺
        execSync('tar -xf "' + fpkPath + '" -C "' + tmp + '"', { stdio: 'pipe' });
    } catch (e) {
        return { success: false, error: '安装包解压失败: ' + (e.message || e) };
    }
    var innerTgz = path.join(tmp, 'app.tgz');
    var appSrc;
    if (fs.existsSync(innerTgz)) {
        appSrc = path.join(tmp, 'app');
        try { fs.mkdirSync(appSrc, { recursive: true }); } catch (e) {}
        try {
            execSync('tar -xzf "' + innerTgz + '" -C "' + appSrc + '"', { stdio: 'pipe' });
        } catch (e) {
            return { success: false, error: 'app.tgz 解压失败: ' + (e.message || e) };
        }
    } else {
        appSrc = fs.existsSync(path.join(tmp, 'server')) ? tmp : null;
    }
    if (!appSrc || !fs.existsSync(path.join(appSrc, 'server')) && !fs.existsSync(path.join(appSrc, 'server.js'))) {
        try { execSync('rm -rf "' + tmp + '"'); } catch (e) {}
        return { success: false, error: 'fpk 包内未找到 app 内容（server 目录）' };
    }
    if (!fs.existsSync(path.join(tmp, 'manifest'))) {
        try { execSync('rm -rf "' + tmp + '"'); } catch (e) {}
        return { success: false, error: 'fpk 包内缺少 manifest' };
    }

    // 备份当前应用目录（target），失败可回滚
    var bak = APPDEST + '.bak';
    try { execSync('rm -rf "' + bak + '"', { stdio: 'ignore' }); } catch (e) {}
    try {
        execSync('cp -a "' + APPDEST + '" "' + bak + '"', { stdio: 'pipe' });
    } catch (e) {
        try { execSync('rm -rf "' + tmp + '"'); } catch (err) {}
        return { success: false, error: '备份当前程序失败: ' + (e.message || e) };
    }

    try {
        // 覆盖应用目录（target）内容
        execSync('cp -a ' + JSON.stringify(appSrc + '/.') + ' ' + JSON.stringify(APPDEST + '/'), { stdio: 'pipe' });
        // 同步 manifest / cmd / ICON 到应用基础目录（应用中心读这里的 manifest 版本号）
        ['manifest', 'cmd', 'ICON.PNG', 'ICON_256.PNG'].forEach(function (item) {
            var s = path.join(tmp, item);
            if (!fs.existsSync(s)) return;
            var d = path.join(APPBASE, item);
            try {
                execSync('cp -a ' + JSON.stringify(s + (fs.statSync(s).isDirectory() ? '/.' : '')) + ' ' + JSON.stringify(d + (fs.statSync(s).isDirectory() ? '/' : '')), { stdio: 'ignore' });
            } catch (e) {}
            // 同时覆盖 target 下的同名（与 fnmonitor 一致）
            var d2 = path.join(APPDEST, item);
            try {
                execSync('cp -a ' + JSON.stringify(s + (fs.statSync(s).isDirectory() ? '/.' : '')) + ' ' + JSON.stringify(d2 + (fs.statSync(s).isDirectory() ? '/' : '')), { stdio: 'ignore' });
            } catch (e) {}
        });
        // 校验新 server.js 存在
        if (!fs.existsSync(path.join(APPDEST, 'server', 'server.js'))) {
            throw new Error('安装后未找到 server/server.js');
        }
    } catch (e) {
        // 回滚
        try { execSync('rm -rf "' + APPDEST + '"', { stdio: 'ignore' }); } catch (err) {}
        try { execSync('cp -a "' + bak + '" "' + APPDEST + '"', { stdio: 'ignore' }); } catch (err) {}
        try { execSync('rm -rf "' + tmp + '"'); } catch (err) {}
        return { success: false, error: '安装失败已回滚: ' + (e.message || e) };
    }
    try { execSync('rm -rf "' + tmp + '"'); } catch (e) {}
    try { execSync('rm -rf "' + bak + '"', { stdio: 'ignore' }); } catch (e) {}

    return { success: true, message: '新版本已安装，服务正在重启…' };
}

// ---- 重启：脱离当前进程调度 cmd/main restart，然后退出 ----
function restart() {
    var cmdMain = path.join(APPBASE, 'cmd', 'main');
    try {
        // 写 restart-trigger 标记（便于排查）
        fs.writeFileSync(path.join(PKGVAR, 'restart-trigger'), String(Date.now()));
    } catch (e) {}
    log('scheduling restart via ' + cmdMain);
    try {
        var child = spawn('bash', ['-c', 'sleep 1.5; "' + cmdMain + '" restart'],
            { detached: true, stdio: 'ignore' });
        child.unref();
    } catch (e) {
        log('spawn restart failed: ' + (e.message || e));
    }
    // 给 HTTP 响应留出送达时间，由 cmd/main stop 终止本进程
    setTimeout(function () {
        log('exiting for restart');
        process.exit(0);
    }, 1200);
}

// ---- 自动检查 ----
function startAutoCheck() {
    if (_autoTimer) return;
    var cfg = loadConfig();
    if (cfg.autocheck === false) { log('autocheck disabled by config'); return; }
    _autoTimer = setInterval(function () {
        var c = loadConfig();
        if (c.autocheck === false) return;
        check(true).then(function (info) {
            if (!info.has_update || !info.asset) return;
            log('auto-check found update ' + info.latest);
            if (c.autoupdate) {
                downloadToNas(info.asset).then(function (r) {
                    if (r.success && r.path) {
                        log('auto-downloaded to ' + r.path);
                        installFpk(r.path).then(function (ir) {
                            if (ir.success) restart();
                            else log('auto-install failed: ' + ir.error);
                        });
                    } else {
                        log('auto-download failed: ' + r.error);
                    }
                });
            }
        }).catch(function (e) { log('auto-check error: ' + (e.message || e)); });
    }, UPDATE_CHECK_INTERVAL);
    log('auto-check started, interval=' + (UPDATE_CHECK_INTERVAL / 3600000) + 'h');
}

// ---- 综合状态（给前端） ----
function getStatus() {
    var dp = downloadedPath();
    return {
        current_version: getCurrentVersion(),
        arch: detectArch(),
        latest_version: _status.latest || (_cache ? _cache.latest : ''),
        has_update: _status.has_update || (_cache ? _cache.has_update : false),
        downloaded: !!dp,
        downloaded_file: dp,
        downloading: _status.downloading,
        last_check: _status.last_check,
        error: _status.error,
        autoupdate: loadConfig().autoupdate || false,
        autocheck: loadConfig().autocheck !== false
    };
}

module.exports = {
    detectArch, getCurrentVersion, check, downloadToNas, installFpk,
    restart, startAutoCheck, getStatus, loadConfig, saveConfig, downloadedPath,
    UPDATE_DIR
};
