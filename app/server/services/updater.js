// 惬意阅读 - 在线更新服务
// 基于 GitHub Releases：检查新版本、下载 fpk 到 NAS、解包覆盖安装、自我重启。
// 挂载到 /api/extra/update/*（由 routes/update.js 调用），无需改动混淆的 server.js。

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');

const UPDATE_REPO = 'MisiteQ/QYRead';
const UPDATE_CHECK_INTERVAL = 6 * 3600 * 1000;  // 6 小时
const GH_MIRRORS = ['', 'https://gh-proxy.com/', 'https://ghfast.top/', 'https://ghproxy.net/', 'https://gh.llkk.cc/'];

// ---- 路径：全部显式用 TRIM_APPNAME 拼接，绝对避免读到其他应用的 manifest ----
const APPNAME = process.env.TRIM_APPNAME || 'qyread';
const TRIM_PKGVAR = process.env.TRIM_PKGVAR || path.join(__dirname, '..', '..', '..');
const TRIM_APPDEST = process.env.TRIM_APPDEST || path.join(__dirname, '..', '..');
const TRIM_APPBASE = path.join(TRIM_PKGVAR, '..', APPNAME);  // /var/apps/{appname}
const PKGVAR = TRIM_PKGVAR;
const APPDEST = TRIM_APPDEST;
const APPBASE = TRIM_APPBASE;
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
    var a = String(process.arch || '').toLowerCase();
    return (a === 'arm64' || a.indexOf('arm') === 0) ? 'arm' : 'x86';
}

// ---- manifest 路径：多重验证 appname 必须匹配 ----
function manifestPath() {
    var candidates = [
        // fnOS 应用基础目录（TRIM_PKGVAR 自身通常就是 /var/apps/{appname}）
        path.join(PKGVAR, 'manifest'),
        // 显式用 APPNAME 拼接
        path.join(APPBASE, 'manifest'),
        // target 目录内（部分安装场景会同步到这里）
        path.join(APPDEST, 'manifest'),
        // 开发期仓库根
        path.join(__dirname, '..', '..', '..', 'manifest')
    ];
    for (var i = 0; i < candidates.length; i++) {
        var p = candidates[i];
        if (fs.existsSync(p)) {
            // 验证 appname 字段必须匹配 qyread，避免读到其他应用的 manifest
            try {
                var txt = fs.readFileSync(p, 'utf8');
                var m = /^appname\s*=\s*(\S+)/m.exec(txt);
                if (m && m[1] === APPNAME) {
                    log('manifest path=' + p);
                    return p;
                } else if (m) {
                    log('skipping manifest (appname=' + m[1] + ') at ' + p);
                }
            } catch (e) {}
        }
    }
    log('WARNING: no valid manifest found for appname=' + APPNAME);
    // 兜底：返回第一个存在的
    for (var j = 0; j < candidates.length; j++) {
        if (fs.existsSync(candidates[j])) return candidates[j];
    }
    return candidates[0];
}

// 严格锚定行首：只匹配首字段 version，不匹配 os_min_version / changelog 内嵌的版本号
function getCurrentVersion() {
    try {
        var txt = fs.readFileSync(manifestPath(), 'utf8');
        var m = /^version\s*=\s*([0-9][0-9A-Za-z.\-]*)/m.exec(txt);
        if (m) {
            log('current version=' + m[1]);
            return m[1];
        }
    } catch (e) {
        log('getCurrentVersion error: ' + (e.message || e));
    }
    log('WARNING: version not found in manifest, defaulting to 0.0.0');
    return '0.0.0';
}

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

// ---- HTTPS：自动跟随 3xx 重定向（GitHub 下载链接必跳 302）----
function followRedirect(res, opts) {
    if (!res.headers.location) return null;
    var loc = res.headers.location;
    // 相对 URL 转绝对
    if (!/^https?:\/\//i.test(loc)) {
        var u = new URL(loc, opts._lastUrl || 'https://placeholder');
        loc = u.href;
    }
    opts._lastUrl = loc;
    var mod = /^https:/i.test(loc) ? https : http;
    return new Promise(function (resolve, reject) {
        var req = mod.get(loc, {
            headers: opts.headers || {},
            timeout: opts.timeout || 30000
        }, function (r) {
            resolve(r);
        });
        req.on('error', reject);
        req.on('timeout', function () { req.destroy(new Error('timeout')); });
    });
}

function httpsGet(url, opts, _depth) {
    opts = opts || {};
    _depth = _depth || 0;
    if (_depth > 5) return Promise.reject(new Error('too many redirects'));
    var mod = /^https:/i.test(url) ? https : http;
    return new Promise(function (resolve, reject) {
        var req = mod.get(url, {
            headers: opts.headers || {},
            timeout: opts.timeout || 30000
        }, function (res) {
            // 3xx 重定向：跟随
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                try { res.resume(); } catch (e) {}
                var loc = res.headers.location;
                if (!/^https?:\/\//i.test(loc)) {
                    try { loc = new URL(loc, url).href; } catch (e) { loc = url.replace(/\/[^/]*$/, '') + '/' + loc.replace(/^\//, ''); }
                }
                httpsGet(loc, opts, _depth + 1).then(resolve).catch(reject);
            } else {
                resolve(res);
            }
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
                return { success: false, error: '安装包 SHA256 校验失败' };
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
    var f = _status.downloaded_file;
    if (f && fs.existsSync(f)) return f;
    try {
        var arch = detectArch();
        var files = fs.readdirSync(UPDATE_DIR).filter(function (n) {
            return /qyread-.*-.*\.fpk$/.test(n) && n.indexOf('-' + arch + '.fpk') !== -1;
        });
        if (files.length) return path.join(UPDATE_DIR, files.sort().pop());
    } catch (e) {}
    return '';
}

// ---- 安装 ----
async function installFpk(fpkPath) {
    var tmp = path.join(UPDATE_DIR, '_extract');
    try { execSync('rm -rf "' + tmp + '"', { stdio: 'ignore' }); } catch (e) {}
    try { fs.mkdirSync(tmp, { recursive: true }); } catch (e) {}
    try {
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
    // 括号明确 && 优先级（避免歧义）
    if (!appSrc || !(fs.existsSync(path.join(appSrc, 'server')) || fs.existsSync(path.join(appSrc, 'server.js')))) {
        try { execSync('rm -rf "' + tmp + '"'); } catch (e) {}
        return { success: false, error: 'fpk 包内未找到 app 内容（server 目录）' };
    }
    if (!fs.existsSync(path.join(tmp, 'manifest'))) {
        try { execSync('rm -rf "' + tmp + '"'); } catch (e) {}
        return { success: false, error: 'fpk 包内缺少 manifest' };
    }

    var bak = APPDEST + '.bak';
    try { execSync('rm -rf "' + bak + '"', { stdio: 'ignore' }); } catch (e) {}
    try {
        execSync('cp -a "' + APPDEST + '" "' + bak + '"', { stdio: 'pipe' });
    } catch (e) {
        try { execSync('rm -rf "' + tmp + '"'); } catch (err) {}
        return { success: false, error: '备份当前程序失败: ' + (e.message || e) };
    }

    try {
        // 覆盖 target 应用目录
        execSync('cp -a ' + JSON.stringify(appSrc + '/.') + ' ' + JSON.stringify(APPDEST + '/'), { stdio: 'pipe' });
        // 同步 manifest / cmd / ICON 到应用基础目录（应用中心读这里的版本号）
        ['manifest', 'cmd', 'ICON.PNG', 'ICON_256.PNG'].forEach(function (item) {
            var s = path.join(tmp, item);
            if (!fs.existsSync(s)) return;
            var isDir = fs.statSync(s).isDirectory();
            // APPBASE：fnOS 应用中心读这里
            var d = path.join(APPBASE, item);
            try {
                execSync('cp -a ' + JSON.stringify(s + (isDir ? '/.' : '')) + ' ' + JSON.stringify(d + (isDir ? '/' : '')), { stdio: 'ignore' });
            } catch (e) {}
            // APPDEST：target 内也保持一份
            var d2 = path.join(APPDEST, item);
            try {
                execSync('cp -a ' + JSON.stringify(s + (isDir ? '/.' : '')) + ' ' + JSON.stringify(d2 + (isDir ? '/' : '')), { stdio: 'ignore' });
            } catch (e) {}
        });
        if (!fs.existsSync(path.join(APPDEST, 'server', 'server.js'))) {
            throw new Error('安装后未找到 server/server.js');
        }
    } catch (e) {
        try { execSync('rm -rf "' + APPDEST + '"', { stdio: 'ignore' }); } catch (err) {}
        try { execSync('cp -a "' + bak + '" "' + APPDEST + '"', { stdio: 'ignore' }); } catch (err) {}
        try { execSync('rm -rf "' + tmp + '"'); } catch (err) {}
        return { success: false, error: '安装失败已回滚: ' + (e.message || e) };
    }
    try { execSync('rm -rf "' + tmp + '"'); } catch (e) {}
    try { execSync('rm -rf "' + bak + '"', { stdio: 'ignore' }); } catch (e) {}

    return { success: true, message: '新版本已安装，服务正在重启…' };
}

// ---- 重启 ----
function restart() {
    var cmdMain = path.join(APPBASE, 'cmd', 'main');
    try {
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

log('updater loaded, APPNAME=' + APPNAME + ' PKGVAR=' + PKGVAR + ' APPDEST=' + APPDEST + ' APPBASE=' + APPBASE);

module.exports = {
    detectArch, getCurrentVersion, check, downloadToNas, installFpk,
    restart, startAutoCheck, getStatus, loadConfig, saveConfig, downloadedPath,
    UPDATE_DIR
};
