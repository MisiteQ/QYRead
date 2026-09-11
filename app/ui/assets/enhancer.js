/*! 惬意阅读 壳层增强（v0.1.16）
 *  前端 bundle 为编译产物，所有增强均通过 DOM 观察外挂实现，不侵入 React 状态。
 *  功能：① 内容宽度滑块 ② 详情页读后感按钮 ③ 书架视图切换（大/中/小/列表，列表带书籍信息）
 *       ④ 阅读器外壳主题跟随 ⑤ 管理中心 AI/成就 tab 容器移除
 *       ⑥ 落地页话术改写 ⑦ 关于页版本号同步 + 致谢信息 + 在线更新 ⑧ 阅读自动加入书架并提示
 *       ⑨ TTS 默认使用 Edge 在线引擎 ⑩ "我的"页用户卡片禁用跳转（成就页已下线）
 *       ⑪ 阅读器白噪音背景音（白/粉/棕噪、雨声、海浪、篝火，仅阅读页显示，离开自动停止）
 *       ⑫ 书架详细列表返回自动刷新 ⑬ 白噪音按钮浮动拖拽 + 播放速度调整 + 初始居中
 *  说明：AI 助手 / 成就中心 / 分享功能已下线；TTS 听书使用 Edge 在线引擎。
 */
(function () {
  'use strict';
  if (window.__qyEnhancerLoaded) return;
  window.__qyEnhancerLoaded = true;

  var LS_CW = 'lr_reader_contentWidth';
  var LS_SHELF_VIEW = 'qy_shelf_view'; // large | medium | small | list
  var CW_MIN = 560, CW_MAX = 1600, CW_STEP = 20, CW_DEFAULT = 960;

  /* ===================== 版本号（从本脚本的 ?v= 戳读取，build 时自动同步） ===================== */
  var QY_VER = '';
  try {
    var _vs = document.querySelector('script[src*="enhancer.js"]');
    if (_vs && _vs.src) {
      var _vm = /[?&]v=([0-9][0-9A-Za-z.\-]*)/.exec(_vs.src);
      if (_vm) QY_VER = _vm[1];
    }
  } catch (e) {}

  /* ===================== TTS 默认引擎：Edge 在线（只在首次运行时默认一次，不覆盖用户选择） ===================== */
  try {
    if (!localStorage.getItem('qy_tts_engine_defaulted')) {
      localStorage.setItem('lr_reader_ttsEngine', 'edge');
      localStorage.setItem('qy_tts_engine_defaulted', '1');
    }
  } catch (e) {}

  /* ===================== 通用工具 ===================== */
  function $(s, r) { return (r || document).querySelector(s); }
  function $all(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(msg) {
    var t = document.getElementById('qy-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'qy-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }
  function api(url, opt) {
    return fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' }, opt || {}))
      .then(function (r) {
        if (!r.ok) return r.json().catch(function () { return {}; }).then(function (e) {
          throw new Error(e.error || ('请求失败 (' + r.status + ')'));
        });
        return r.status === 204 ? null : r.json();
      });
  }
  function fmtDuration(sec) {
    sec = Math.round(sec || 0);
    if (sec < 60) return sec + ' 秒';
    var m = Math.floor(sec / 60);
    if (m < 60) return m + ' 分钟';
    var h = Math.floor(m / 60), mm = m % 60;
    return h + ' 小时' + (mm ? ' ' + mm + ' 分' : '');
  }
  function countWords(s) {
    var cn = (s.match(/[一-鿿]/g) || []).length;
    var en = (s.replace(/[一-鿿]/g, ' ').match(/[A-Za-z0-9]+/g) || []).length;
    return cn + en;
  }

  /* ===================== 1. 阅读内容宽度 ===================== */
  function getCw() {
    var v = parseInt(localStorage.getItem(LS_CW), 10);
    return (!isNaN(v) && v >= CW_MIN && v <= CW_MAX) ? v : CW_DEFAULT;
  }
  function applyCw(v) {
    document.documentElement.style.setProperty('--lr-cw', v + 'px');
  }
  (function initCwStyle() {
    var st = document.createElement('style');
    st.id = 'qy-cw-style';
    st.textContent =
      ':root{--lr-cw:' + CW_DEFAULT + 'px}' +
      '.chapter-article{max-width:var(--lr-cw) !important;margin-left:auto !important;margin-right:auto !important;}';
    document.documentElement.appendChild(st);
    applyCw(getCw());
  })();

  function tryInjectWidthRow(rootNode) {
    var scope = rootNode && rootNode.querySelectorAll ? rootNode : document;
    var spans = $all('span', scope);
    for (var i = 0; i < spans.length; i++) {
      var sp = spans[i];
      if (sp.textContent.trim() !== '左右边距' || sp.children.length > 0) continue;
      var row = sp;
      for (var k = 0; k < 6 && row; k++) {
        row = row.parentElement;
        if (row && row.querySelector('input[type="range"]')) break;
      }
      if (!row) continue;
      var host = row.parentElement;
      if (!host || host.querySelector('[data-qy-cw]')) continue;

      var clone = row.cloneNode(true);
      clone.setAttribute('data-qy-cw', '1');
      var labels = clone.querySelectorAll('span');
      if (labels[0]) labels[0].textContent = '内容宽度';
      var valLabel = labels[labels.length - 1];
      var input = clone.querySelector('input[type="range"]');
      input.min = CW_MIN; input.max = CW_MAX; input.step = CW_STEP;
      input.value = getCw();
      input.setAttribute('aria-label', '内容宽度');
      function syncLabel() { if (valLabel) valLabel.textContent = input.value + 'px'; }
      syncLabel();
      input.addEventListener('input', function () {
        var v = parseInt(input.value, 10);
        localStorage.setItem(LS_CW, String(v));
        applyCw(v);
        syncLabel();
      });
      input.addEventListener('click', function (e) { e.stopPropagation(); });
      host.insertBefore(clone, row.nextSibling);
    }
  }

  /* ===================== 2. 详情页：读后感按钮注入 ===================== */
  try {
    var origFetch = window.fetch;
    window.fetch = function (input) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      // 关于页版本号：混淆 server.js 里硬编码了旧版本，直接以构建版本为准
      // bundle 只用返回值的 .json()，用普通对象即可，避免依赖 Response 构造器
      if (/\/api\/public\/version(?:\?|$)/.test(url) && QY_VER) {
        return Promise.resolve({
          ok: true, status: 200,
          json: function () { return Promise.resolve({ version: QY_VER }); }
        });
      }
      var p = origFetch.apply(this, arguments);
      var m = /\/api\/books\/(\d+)\/detail(?:\?|$)/.exec(url);
      if (m) {
        p.then(function (r) {
          r.clone().json().then(function (d) {
            window.__qyBook = { id: parseInt(m[1], 10), data: d, at: Date.now() };
            try { scheduleScan(); } catch (e) {}
            setTimeout(function () { try { scheduleScan(); } catch (e2) {} }, 600);
          }).catch(function () {});
        }).catch(function () {});
      }
      return p;
    };
  } catch (e) {}

  // XMLHttpRequest 拦截（覆盖 axios / 原生 XHR 场景）
  try {
    var _origOpen = XMLHttpRequest.prototype.open;
    var _origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__qyUrl = typeof url === 'string' ? url : '';
      return _origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var self = this;
      if (self.__qyUrl && /\/api\/public\/version(?:\?|$)/.test(self.__qyUrl) && QY_VER) {
        setTimeout(function () {
          try {
            Object.defineProperty(self, 'readyState', { value: 4, configurable: true });
            Object.defineProperty(self, 'status', { value: 200, configurable: true });
            Object.defineProperty(self, 'responseText', { value: JSON.stringify({ version: QY_VER }), configurable: true });
            Object.defineProperty(self, 'response', { value: JSON.stringify({ version: QY_VER }), configurable: true });
            if (typeof self.onload === 'function') self.onload.call(self);
            if (typeof self.onreadystatechange === 'function') self.onreadystatechange.call(self);
          } catch (e) {}
        }, 0);
        return;
      }
      return _origSend.apply(this, arguments);
    };
  } catch (e) {}

  function bookFresh() {
    var b = window.__qyBook;
    return b && (Date.now() - b.at < 6000) ? b : null;
  }

  function tryInjectDetailActions() {
    var b = bookFresh();
    if (!b) return;
    var startBtn = null;
    var btns = $all('button, a');
    for (var i = 0; i < btns.length; i++) {
      var x = btns[i];
      if (x.getAttribute('data-qy-act')) continue;
      if (x.offsetParent === null && x.getClientRects().length === 0) continue;
      var tx = (x.textContent || '').trim();
      if (tx === '开始阅读' || tx === '继续阅读') {
        var sibs = x.parentElement ? x.parentElement.querySelectorAll('button,a') : [];
        var hasShelf = false;
        for (var j = 0; j < sibs.length; j++) {
          if (sibs[j].textContent.indexOf('书架') !== -1) { hasShelf = true; break; }
        }
        if (hasShelf) { startBtn = x; break; }
      }
    }
    if (!startBtn) return;
    var bar = startBtn.parentElement;
    if (!bar) return;
    if (bar.getAttribute('data-qy-book') === String(b.id)) return;
    $all('[data-qy-act]').forEach(function (n) { n.parentNode && n.parentNode.removeChild(n); });

    var reviewBtn = startBtn.cloneNode(true);
    reviewBtn.setAttribute('data-qy-act', '1');
    reviewBtn.textContent = '✍️ 读后感';
    reviewBtn.removeAttribute('disabled');
    reviewBtn.style.cursor = 'pointer';
    if (reviewBtn.tagName === 'A') reviewBtn.setAttribute('href', 'javascript:void(0)');
    reviewBtn.addEventListener('click', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      openReviewModal(b);
    });
    bar.appendChild(reviewBtn);
    bar.setAttribute('data-qy-book', String(b.id));
  }

  /* ===================== 弹窗框架 ===================== */
  var modalStyleInjected = false;
  function injectModalStyle() {
    if (modalStyleInjected) return;
    modalStyleInjected = true;
    var st = document.createElement('style');
    st.textContent = [
      '#qy-toast{position:fixed;left:50%;top:max(20px,env(safe-area-inset-top));transform:translateX(-50%) translateY(-18px);',
      'background:rgba(0,0,0,.82);color:#fff;padding:9px 18px;border-radius:999px;font-size:14px;z-index:10005;',
      'opacity:0;transition:.25s;pointer-events:none;max-width:84vw;text-align:center}',
      '#qy-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}',
      '.qy-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:10000;display:flex;align-items:flex-end;justify-content:center}',
      '@media(min-width:640px){.qy-mask{align-items:center}}',
      '.qy-modal{background:#fff;color:#1f2329;width:100%;max-width:520px;max-height:88vh;overflow:auto;border-radius:18px 18px 0 0;',
      'padding:18px 18px calc(18px + env(safe-area-inset-bottom));box-shadow:0 -8px 30px rgba(0,0,0,.18)}',
      '@media(min-width:640px){.qy-modal{border-radius:18px;padding:22px}}',
      '.qy-modal h3{margin:0 0 4px;font-size:17px}',
      '.qy-modal .qy-sub{color:#8a9099;font-size:12.5px;margin-bottom:12px;word-break:break-all}',
      '.qy-modal textarea{width:100%;min-height:180px;border:1px solid #e3e6ea;border-radius:12px;padding:12px;font-size:15px;',
      'line-height:1.8;resize:vertical;outline:none;font-family:inherit;box-sizing:border-box;color:inherit;background:transparent}',
      '.qy-modal textarea:focus{border-color:#3370ff}',
      '.qy-modal .qy-row{display:flex;align-items:center;gap:10px;margin-top:12px;flex-wrap:wrap}',
      '.qy-modal .qy-stat{flex:1;color:#8a9099;font-size:12.5px;min-width:130px}',
      '.qy-btn{border:none;border-radius:999px;padding:9px 18px;font-size:14px;cursor:pointer;font-family:inherit}',
      '.qy-btn-primary{background:#3370ff;color:#fff}',
      '.qy-btn-ghost{background:#f2f3f5;color:#4e5969}',
      '.qy-btn-danger{background:transparent;color:#e5484d;border:1px solid #f0c6c8}',
      '.qy-link{color:#3370ff;font-size:13px;text-decoration:none}',
      '@media(prefers-color-scheme:dark){',
      '.qy-modal{background:#222326;color:#e8e6e1;box-shadow:0 -8px 30px rgba(0,0,0,.5)}',
      '.qy-btn-ghost{background:#2f3033;color:#c9ccd2}}'
    ].join('');
    document.documentElement.appendChild(st);
  }
  function openModal(innerHtml) {
    injectModalStyle();
    var mask = document.createElement('div');
    mask.className = 'qy-mask';
    var m = document.createElement('div');
    m.className = 'qy-modal';
    m.innerHTML = innerHtml;
    mask.appendChild(m);
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    function close() { mask.parentNode && mask.parentNode.removeChild(mask); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    document.body.appendChild(mask);
    return { mask: mask, root: m, close: close };
  }

  /* ---------- 读后感弹窗 ---------- */
  function openReviewModal(b) {
    var title = (b.data && (b.data.title || b.data.name)) || ('书籍 #' + b.id);
    var ui = openModal(
      '<h3>✍️ 读后感</h3>' +
      '<div class="qy-sub">《' + esc(title) + '》　心得随时保存</div>' +
      '<textarea placeholder="记录你对这本书的感想、收获与思考…"></textarea>' +
      '<div class="qy-row"><span class="qy-stat">加载中…</span>' +
      '<button class="qy-btn qy-btn-danger" data-act="del">删除</button>' +
      '<button class="qy-btn qy-btn-primary" data-act="save">保存</button></div>' +
      '<div class="qy-row" style="justify-content:space-between">' +
      '<a class="qy-link" href="/api/extra/reviews/page" target="_blank">📚 查看全部读后感</a></div>'
    );
    var ta = ui.root.querySelector('textarea'), stat = ui.root.querySelector('.qy-stat');
    function refreshStat(extra) { stat.textContent = '字数 ' + countWords(ta.value) + (extra ? '　' + extra : ''); }

    var readingText = '';
    Promise.all([
      api('/api/extra/reviews/' + b.id).catch(function () { return { content: '' }; }),
      api('/api/stats/reading-progress?limit=300').catch(function () { return []; })
    ]).then(function (rs) {
      var review = rs[0] || {}, prog = rs[1] || [];
      ta.value = review.content || '';
      var item = null;
      if (Array.isArray(prog)) {
        for (var i = 0; i < prog.length; i++) {
          if (prog[i] && (prog[i].book_id === b.id || prog[i].id === b.id)) { item = prog[i]; break; }
        }
      }
      var sec = item ? (item.total_reading_time != null ? item.total_reading_time : item.reading_time) : 0;
      readingText = sec ? '累计阅读 ' + fmtDuration(sec) : '暂无阅读时长记录';
      refreshStat(readingText);
    });
    ta.addEventListener('input', function () { refreshStat(readingText); });

    ui.root.querySelector('[data-act="save"]').addEventListener('click', function () {
      var btn = this; btn.disabled = true;
      api('/api/extra/reviews/' + b.id, { method: 'PUT', body: JSON.stringify({ content: ta.value }) })
        .then(function () { toast('读后感已保存'); ui.close(); })
        .catch(function (e) { toast(e.message); btn.disabled = false; });
    });
    ui.root.querySelector('[data-act="del"]').addEventListener('click', function () {
      if (!ta.value.trim() || confirm('确定删除这篇读后感？')) {
        api('/api/extra/reviews/' + b.id, { method: 'DELETE' })
          .then(function () { toast('已删除'); ui.close(); })
          .catch(function (e) { toast(e.message); });
      }
    });
    setTimeout(function () { ta.focus(); }, 60);
  }

  /* ===================== 3. 书架视图切换（按 bundle 真实 DOM 重写，v0.1.4） =====================
   * 真实结构（混淆 bundle 解出）：
   *   网格容器：div.grid，类名 grid-cols-[repeat(auto-fill,minmax(96px,1fr))]（md 断点 120px）
   *   书籍卡片：div.group.relative.flex.w-full.max-w-[150px].mx-auto.flex-col.gap-2
   *             ├ 封面：div.aspect-[2/3].shadow-md.rounded-r-lg.border-l-4（内含 img.object-cover）
   *             └ 标题：div.text-center.text-xs.font-medium.truncate.px-1
   *   文件夹卡片：外层同 max-w-[150px] flex-col 结构，一并适配
   * Tailwind 无语义类名，靠 JS 打 data 标记 + CSS 覆盖。
   */
  var SHELF_SIZES = ['large', 'medium', 'small', 'list'];
  var SHELF_LABELS = { large: '大封面', medium: '中封面', small: '小封面', list: '详细列表' };
  var SHELF_GRID_SEL = 'div.grid[class*="minmax(96px"]';
  var SHELF_CARD_HINT = 'max-w-[150px]';

  // 一次性注入：切换条样式 + 四种视图的覆盖规则
  (function injectShelfCss() {
    if (document.getElementById('qy-shelf-style')) return;
    var st = document.createElement('style');
    st.id = 'qy-shelf-style';
    st.textContent =
      '#qy-shelf-switch{display:flex;justify-content:flex-end;padding:2px 2px 10px}' +
      '#qy-shelf-switch button{border:1px solid #d8dbe0;background:transparent;color:#4e5969;' +
      'border-radius:999px;padding:5px 12px;font-size:12px;cursor:pointer;font-family:inherit;margin-left:8px}' +
      '#qy-shelf-switch button:first-child{margin-left:0}' +
      '#qy-shelf-switch button.on{background:#3370ff;border-color:#3370ff;color:#fff}' +
      // 大封面
      'body[data-qy-shelf-view="large"] [data-qy-grid]{grid-template-columns:repeat(auto-fill,minmax(138px,1fr))!important;gap:16px!important}' +
      '@media(min-width:768px){body[data-qy-shelf-view="large"] [data-qy-grid]{grid-template-columns:repeat(auto-fill,minmax(168px,1fr))!important;gap:20px!important}}' +
      'body[data-qy-shelf-view="large"] [data-qy-card]{max-width:220px!important;gap:6px!important}' +
      'body[data-qy-shelf-view="large"] [data-qy-title]{font-size:13px!important}' +
      // 小封面
      'body[data-qy-shelf-view="small"] [data-qy-grid]{grid-template-columns:repeat(auto-fill,minmax(66px,1fr))!important;gap:8px!important}' +
      '@media(min-width:768px){body[data-qy-shelf-view="small"] [data-qy-grid]{grid-template-columns:repeat(auto-fill,minmax(86px,1fr))!important;gap:10px!important}}' +
      'body[data-qy-shelf-view="small"] [data-qy-card]{max-width:96px!important;gap:4px!important}' +
      'body[data-qy-shelf-view="small"] [data-qy-title]{font-size:11px!important}' +
      // 详细列表：纯文本行，不要封面缩略图
      'body[data-qy-shelf-view="list"] [data-qy-grid]{display:flex!important;flex-direction:column!important;gap:0!important}' +
      'body[data-qy-shelf-view="list"] [data-qy-card]{flex-direction:row!important;align-items:flex-start!important;' +
      'max-width:none!important;width:100%!important;margin:0!important;gap:0!important;' +
      'padding:10px 8px!important;border-bottom:1px solid rgba(127,127,127,.15)!important;border-radius:0!important}' +
      'body[data-qy-shelf-view="list"] [data-qy-card]:active{background:rgba(127,127,127,.06)}' +
      'body[data-qy-shelf-view="list"] [data-qy-card]:hover{background:rgba(127,127,127,.04)}' +
      'body[data-qy-shelf-view="list"] [data-qy-cover]{display:none!important}' +
      'body[data-qy-shelf-view="list"] [data-qy-title]{flex:1 1 auto!important;text-align:left!important;' +
      'font-size:14px!important;font-weight:500!important;padding:2px 4px!important;' +
      'white-space:normal!important;overflow:hidden!important;display:flex!important;flex-direction:column!important;gap:2px!important}' +
      'body[data-qy-shelf-view="list"] .qy-book-name{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      'body[data-qy-shelf-view="list"] .qy-book-meta{display:block!important;font-size:12px!important;' +
      'font-weight:400!important;color:rgba(0,0,0,.55)!important;opacity:1!important;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      'body[data-qy-shelf-view="list"][data-theme="dark"] .qy-book-meta,' +
      'body[data-qy-shelf-view="list"][data-theme="night"] .qy-book-meta{color:rgba(255,255,255,.55)!important}' +
      '.qy-book-meta{display:none!important}';
    document.documentElement.appendChild(st);
  })();

  function getShelfView() {
    var v = localStorage.getItem(LS_SHELF_VIEW);
    return SHELF_SIZES.indexOf(v) >= 0 ? v : 'medium';
  }

  // 给 React 渲染出来的网格 / 卡片 / 封面 / 标题打标记（React 重渲染后需要重新打）
  function markShelfDom() {
    var grids = $all(SHELF_GRID_SEL);
    if (!grids.length) {
      // 兜底：精确 selector 失效时，找任何含 max-w-[150px] 卡片子元素的 grid 容器
      var allGridLike = $all('div[class*="grid"]');
      for (var fi = 0; fi < allGridLike.length; fi++) {
        if (allGridLike[fi].querySelector('[class*="max-w-[150px]"]')) { grids = [allGridLike[fi]]; break; }
      }
    }
    for (var gi = 0; gi < grids.length; gi++) {
      var grid = grids[gi];
      grid.setAttribute('data-qy-grid', '');
      var cards = grid.children;
      for (var ci = 0; ci < cards.length; ci++) {
        var card = cards[ci];
        if (card.nodeType !== 1 || (card.className || '').indexOf(SHELF_CARD_HINT) === -1) continue;
        card.setAttribute('data-qy-card', '');
        var cover = card.querySelector('[class*="aspect-[2/3]"]');
        if (cover) cover.setAttribute('data-qy-cover', '');
        for (var k = card.children.length - 1; k >= 0; k--) {
          var c = card.children[k];
          if (c.nodeType === 1 && (c.className || '').indexOf('truncate') !== -1) {
            c.setAttribute('data-qy-title', '');
            break;
          }
        }
      }
    }
  }

  function setActiveButtons(row, size) {
    if (!row) return;
    $all('button', row).forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-qy-view') === size);
    });
  }

  function tryInjectShelfSwitch() {
    var grid = document.querySelector(SHELF_GRID_SEL);
    if (!grid) return;
    markShelfDom();
    document.body.setAttribute('data-qy-shelf-view', getShelfView());

    var wrap = grid.parentElement; // div.pb-4
    if (!wrap) return;
    var holder = wrap.previousElementSibling;
    if (!holder || holder.id !== 'qy-shelf-switch') {
      holder = document.createElement('div');
      holder.id = 'qy-shelf-switch';
      SHELF_SIZES.forEach(function (sz) {
        var b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('data-qy-view', sz);
        b.textContent = SHELF_LABELS[sz];
        b.addEventListener('click', function () {
          localStorage.setItem(LS_SHELF_VIEW, sz);
          document.body.setAttribute('data-qy-shelf-view', sz);
          setActiveButtons(holder, sz);
          if (sz === 'list') try { enrichListMeta(); } catch (e) {}
        });
        holder.appendChild(b);
      });
      wrap.parentNode.insertBefore(holder, wrap);
    }
    setActiveButtons(holder, getShelfView());
  }

  /* ===================== 4. 阅读器外壳主题跟随 ===================== */
  function syncReaderShell() {
    var article = document.querySelector('.chapter-article');
    if (!article) return;
    try {
      var bg = getComputedStyle(article).backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)') {
        document.documentElement.style.setProperty('--qy-shell-bg', bg);
        document.body.style.backgroundColor = bg;
      }
    } catch (e) {}
  }
  // 观察阅读区 style/class 变化（主题切换时 React 会重设 style）
  var _shellObserver = null;
  function startShellObserver() {
    if (_shellObserver) return;
    var article = document.querySelector('.chapter-article');
    if (!article) return;
    syncReaderShell();
    _shellObserver = new MutationObserver(syncReaderShell);
    _shellObserver.observe(article, { attributes: true, attributeFilter: ['style', 'class'] });
  }

  /* ===================== 4b. 打开阅读的书籍自动加入书架 + 提示 ===================== */
  var AUTO_SHELF_KEY = 'qy_auto_shelfed_v1';
  var autoShelfTried = Object.create(null); // 本次页面生命周期已处理过的 bookId

  function loadAutoShelfed() {
    try { return JSON.parse(localStorage.getItem(AUTO_SHELF_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }
  function saveAutoShelfed(m) {
    try { localStorage.setItem(AUTO_SHELF_KEY, JSON.stringify(m)); } catch (e) {}
  }
  // 书架页会把在架书目缓存到 sessionStorage（lr_library_books_cache），用它判断"是否首次入架"
  function shelfCacheHas(id) {
    try {
      var a = JSON.parse(sessionStorage.getItem('lr_library_books_cache') || '[]');
      return Array.isArray(a) && a.some(function (b) { return b && String(b.id) === String(id); });
    } catch (e) { return false; }
  }
  function currentReadId() {
    var m = /^\/read\/(\d+)/.exec(location.pathname);
    return m ? m[1] : null;
  }
  function notifyAutoShelf(id) {
    var tries = 0, timer = null;
    (function attempt() {
      var b = (window.__qyBook && String(window.__qyBook.id) === String(id)) ? window.__qyBook.data : null;
      var title = b && (b.title || b.name);
      if (title) { toast('📚 已将《' + title + '》加入书架'); }
      else if (++tries < 8) { timer = setTimeout(attempt, 500); return; }
      else { toast('📚 阅读的书籍已自动加入书架'); }
      timer = null;
    })();
  }
  function checkAutoShelf() {
    var id = currentReadId();
    if (!id || autoShelfTried[id]) return;
    autoShelfTried[id] = true;
    var shelfed = loadAutoShelfed();
    var already = !!shelfed[id] || shelfCacheHas(id);
    var token = localStorage.getItem('lr_token') || localStorage.getItem('token') || '';
    var bookId = /^\d+$/.test(id) ? Number(id) : id;
    fetch('/api/books/bookshelf/batch', {
      method: 'PUT',
      credentials: 'include',
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        token ? { Authorization: 'Bearer ' + token } : {}
      ),
      body: JSON.stringify({ bookIds: [bookId], folderId: null })
    }).then(function (r) {
      if (!r.ok) return;
      shelfed[id] = Date.now();
      saveAutoShelfed(shelfed);
      if (!already) notifyAutoShelf(id);
    }).catch(function () {});
  }
  // SPA 路由变化（bundle 用 history.pushState 跳转 /read/:id）
  try {
    ['pushState', 'replaceState'].forEach(function (m) {
      var orig = history[m];
      history[m] = function () {
        var ret = orig.apply(this, arguments);
        setTimeout(checkAutoShelf, 0);
        return ret;
      };
    });
    window.addEventListener('popstate', function () { setTimeout(checkAutoShelf, 0); });
  } catch (e) {}

  /* ===================== 4c. “我的”页用户卡片禁用点击（原跳转成就页，后端已移除会崩溃） ===================== */
  (function initProfileStyle() {
    var st = document.createElement('style');
    st.id = 'qy-profile-style';
    st.textContent =
      '[data-qy-profile]{cursor:default!important}' +
      '[data-qy-profile]:active{transform:none!important}';
    document.documentElement.appendChild(st);
  })();
  // 判断一个元素是不是“我的”页顶部的用户大卡片：
  // 类名带 rounded-[20px] + justify-between，且卡片文本里含“已阅读 N 分钟”。
  function isProfileCard(el) {
    if (!el || el.nodeType !== 1) return false;
    var cn = el.className || '';
    if (typeof cn !== 'string') cn = (el.getAttribute('class') || '');
    if (cn.indexOf('rounded-[20px]') === -1 || cn.indexOf('justify-between') === -1) return false;
    return /已阅读\s*\d+/.test(el.textContent || '');
  }
  // 双保险：document 捕获阶段一次性常驻监听，点击时实时识别并拦截，
  // 不依赖扫描标记时机，React 重渲染换了节点也照样拦住（先于 React 根节点的合成事件）。
  document.addEventListener('click', function (e) {
    var node = e.target;
    for (var i = 0; i < 8 && node && node !== document.body; i++) {
      if (node.nodeType === 1 && node.hasAttribute && node.hasAttribute('data-qy-profile')) {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        return;
      }
      if (node.nodeType === 1 && isProfileCard(node)) {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        return;
      }
      node = node.parentElement;
    }
  }, true);
  function neutralizeProfileCard() {
    // 用 TreeWalker 找“已阅读 N…”文本节点（它可能在 span/div 内，且可能有兄弟元素，不能只查 span）
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var n, hits = [];
    while ((n = walker.nextNode())) {
      if (/已阅读\s*\d+/.test(n.nodeValue || '')) hits.push(n);
    }
    hits.forEach(function (textNode) {
      var card = textNode.parentElement, found = null;
      for (var k = 0; k < 6 && card; k++) {
        card = card.parentElement;
        if (card && isProfileCard(card)) { found = card; break; }
      }
      if (!found || found.getAttribute('data-qy-profile')) return;
      found.setAttribute('data-qy-profile', '1');
      // 卡片自身再绑一道捕获拦截（document 级监听之外的冗余保险）
      found.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); }, true);
      // 右侧 “>” 箭头（bundle 里是 w-5 h-5 的 svg）一并隐藏
      var chev = found.lastElementChild;
      if (chev && chev.tagName === 'SVG') chev.style.setProperty('display', 'none', 'important');
    });
  }

  /* ===================== 4d. 关于页：致谢上游项目 ===================== */
  function injectAboutCredit() {
    var h3s = document.getElementsByTagName('h3');
    for (var i = 0; i < h3s.length; i++) {
      if ((h3s[i].textContent || '').trim() !== '惬意阅读') continue;
      var root = h3s[i].closest ? h3s[i].closest('.p-4') : null;
      var box = root ? root.querySelector('.max-w-sm') : null;
      if (!box || box.querySelector('[data-qy-credit]')) return;
      var card = document.createElement('div');
      card.setAttribute('data-qy-credit', '1');
      card.className = 'p-4 rounded-xl';
      card.style.cssText = 'background:rgba(127,127,127,.10)';
      card.innerHTML =
        '<h4 class="font-medium mb-2">致谢</h4>' +
        '<p style="font-size:13px;line-height:1.7;opacity:.72;margin-bottom:6px">' +
        '本项目基于以下开源项目的功能改造而来，谨致谢意：</p>' +
        '<ul style="font-size:13px;line-height:2;opacity:.88">' +
        '<li>📖 落地长安《轻阅读》——书库管理与沉浸阅读相关功能</li>' +
        '<li>📚 zsyo《go-novel》——小说搜索与下载相关模块</li></ul>';
      // 作者卡之后、版权 footer 之前
      box.insertBefore(card, box.children[2] || null);
      return;
    }
  }

  /* ===================== 4e. 关于页：在线更新面板 ===================== */
  var _updBox = null, _updState = null, _updChecking = false;
  function updApi(url, opt) {
    var token = localStorage.getItem('lr_token') || localStorage.getItem('token') || '';
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return fetch(url, Object.assign({ headers: headers, credentials: 'same-origin' }, opt || {}))
      .then(function (r) {
        if (!r.ok) return r.json().catch(function () { return {}; }).then(function (e) {
          throw new Error(e.error || ('请求失败 (' + r.status + ')'));
        });
        return r.status === 204 ? null : r.json();
      });
  }
  function injectUpdatePanel() {
    var h3s = document.getElementsByTagName('h3');
    for (var i = 0; i < h3s.length; i++) {
      if ((h3s[i].textContent || '').trim() !== '惬意阅读') continue;
      var root = h3s[i].closest ? h3s[i].closest('.p-4') : null;
      var box = root ? root.querySelector('.max-w-sm') : null;
      if (!box || box.querySelector('[data-qy-update]')) return;
      var card = document.createElement('div');
      card.setAttribute('data-qy-update', '1');
      card.className = 'p-4 rounded-xl';
      card.style.cssText = 'background:rgba(51,112,255,.08);margin-top:12px';
      card.innerHTML =
        '<h4 class="font-medium mb-2">软件更新</h4>' +
        '<div style="font-size:13px;line-height:1.9;opacity:.88">' +
          '<div>当前版本：<b data-qy-upd-cur>—</b></div>' +
          '<div>最新版本：<b data-qy-upd-latest>—</b></div>' +
          '<div data-qy-upd-msg style="opacity:.7;font-size:12px"></div>' +
          '<div style="font-size:12px;margin-top:2px">项目地址：' +
            '<a href="https://github.com/MisiteQ/QYRead" target="_blank" rel="noopener" ' +
            'style="color:#3370ff;word-break:break-all">github.com/MisiteQ/QYRead</a></div>' +
        '</div>' +
        '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">' +
          '<button type="button" data-qy-upd-check>检查更新</button>' +
          '<button type="button" data-qy-upd-dl>下载到 NAS</button>' +
          '<button type="button" data-qy-upd-install>立即更新</button>' +
          '<a href="https://github.com/MisiteQ/QYRead/releases" target="_blank" rel="noopener" ' +
            'data-qy-upd-gh style="text-decoration:none;border:1px solid rgba(51,112,255,.4);' +
            'border-radius:8px;padding:6px 12px;font-size:12px;color:#3370ff;background:#fff;">GitHub 下载</a>' +
        '</div>' +
        '<label style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:12px;opacity:.8">' +
          '<input type="checkbox" data-qy-upd-auto> 自动检查并安装更新</label>';
      box.appendChild(card);
      _updBox = card;
      // 统一按钮样式
      card.querySelectorAll('button').forEach(function (b) {
        b.dataset.enabled = '1';
        b.style.cssText = 'border:1px solid rgba(51,112,255,.4);background:#3370ff;color:#fff;' +
          'border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer';
      });
      // 按钮启用/禁用统一样式（禁用时置灰 + 禁止光标 + 提示，避免“点击没反应”）
      card._setBtn = function (btn, enabled, title) {
        btn.disabled = !enabled;
        btn.title = title || '';
        if (enabled) {
          btn.style.cssText = 'border:1px solid rgba(51,112,255,.4);background:#3370ff;color:#fff;' +
            'border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer';
        } else {
          btn.style.cssText = 'border:1px solid #ccc;background:#e5e7eb;color:#9ca3af;' +
            'border-radius:8px;padding:6px 12px;font-size:12px;cursor:not-allowed';
        }
      };
      var dlBtn = card.querySelector('[data-qy-upd-dl]');
      var inBtn = card.querySelector('[data-qy-upd-install]');
      card._setBtn(dlBtn, false, '请先点击「检查更新」发现新版本');
      card._setBtn(inBtn, false, '请先下载更新包到 NAS');
      card.querySelector('[data-qy-upd-check]').addEventListener('click', updCheck);
      dlBtn.addEventListener('click', updDownload);
      inBtn.addEventListener('click', updInstall);
      card.querySelector('[data-qy-upd-auto]').addEventListener('change', function (e) {
        updApi('/api/extra/update/config', { method: 'POST', body: JSON.stringify({ autoupdate: e.target.checked }) })
          .then(function () {}).catch(function (err) { toast('保存配置失败：' + err.message); });
      });
      updRefresh();
      return;
    }
  }
  function updRefresh() {
    if (!_updBox) return;
    updApi('/api/extra/update/status').then(function (s) {
      _updState = s || {};
      _updBox.querySelector('[data-qy-upd-cur]').textContent = s.current_version || '—';
      _updBox.querySelector('[data-qy-upd-latest]').textContent = s.latest_version || '—';
      var msg = _updBox.querySelector('[data-qy-upd-msg]');
      var dlBtn = _updBox.querySelector('[data-qy-upd-dl]');
      var inBtn = _updBox.querySelector('[data-qy-upd-install]');
      if (s.has_update) {
        msg.textContent = '发现新版本，可下载安装';
        _updBox._setBtn(dlBtn, true, '下载 ' + (s.latest_version || '新版本') + ' 安装包到 NAS');
      } else {
        msg.textContent = s.latest_version ? '已是最新版本' : '点击检查更新';
        _updBox._setBtn(dlBtn, false, s.latest_version ? '当前已是最新版本，无需下载' : '请先点击「检查更新」');
      }
      if (s.error) {
        msg.textContent = '检查更新出错：' + s.error;
      }
      if (s.downloaded) {
        msg.textContent = '已下载，可立即更新';
        _updBox._setBtn(inBtn, true, '安装已下载的更新并重启服务');
      } else {
        _updBox._setBtn(inBtn, false, '请先下载更新包到 NAS');
      }
      _updBox.querySelector('[data-qy-upd-auto]').checked = !!s.autoupdate;
    }).catch(function () {
      var m = _updBox.querySelector('[data-qy-upd-msg]');
      if (m) m.textContent = '更新服务未就绪（需管理员登录）';
    });
  }
  function updCheck() {
    if (_updChecking) return;
    _updChecking = true;
    toast('正在检查更新…');
    updApi('/api/extra/update/check', { method: 'POST' }).then(function (s) {
      _updChecking = false;
      _updState = s || {};
      updRefresh();
      toast(s.has_update ? ('发现新版本 ' + (s.latest_version || '')) : '已是最新版本');
    }).catch(function (err) { _updChecking = false; toast('检查失败：' + err.message); });
  }
  function updDownload() {
    if (!_updState || !_updState.has_update) { toast('请先检查更新'); return; }
    toast('开始下载更新包…');
    updApi('/api/extra/update/download', { method: 'POST' }).then(function (r) {
      toast(r && r.downloaded ? '下载完成，可立即更新' : '下载完成');
      updRefresh();
    }).catch(function (err) { toast('下载失败：' + err.message); });
  }
  function updInstall() {
    if (!_updState || !_updState.downloaded) { toast('请先下载更新包'); return; }
    if (!confirm('确认安装更新？服务将重启。')) return;
    toast('正在安装更新，服务即将重启…');
    updApi('/api/extra/update/install', { method: 'POST' }).then(function () {
      toast('更新完成，等待服务重启…');
      setTimeout(function () { location.reload(); }, 8000);
    }).catch(function (err) { toast('安装失败：' + err.message); });
  }

  /* ===================== 4f. 书架详细列表：补充作者/章节/进度 =====================
   * 书架列表接口 /api/books?in_bookshelf=1 只返回 books 表本身字段（id/title/author/...），
   * 进度/章节在独立的 progress 表，由另一个接口返回。
   * 这里合并两个 API：
   *   ① /api/books?in_bookshelf=1&limit=1000            全量书架（book.id 主键）
   *   ② /api/stats/reading-progress?limit=500           有进度的书子集（book_id 主键）
   */
  var SHELF_META_TTL = 30000;
  var BS_CACHE_KEY = 'lr_library_books_cache';  // bundle 自己存的书架全量缓存
  var shelfMetaMap = null, shelfMetaAt = 0, shelfMetaLoading = false;
  var shelfMetaReqId = 0, shelfMetaEmptyRetries = 0, SHELF_META_EMPTY_MAX = 6;
  // 列表类接口响应归一：兼容数组 / {books} / {items} / {data}
  function normalizeList(d) {
    if (Array.isArray(d)) return d;
    if (d && Array.isArray(d.books)) return d.books;
    if (d && Array.isArray(d.items)) return d.items;
    if (d && Array.isArray(d.data)) return d.data;
    return [];
  }
  function readBooksFromCache() {
    try {
      var raw = sessionStorage.getItem(BS_CACHE_KEY);
      if (!raw) return null;
      var arr = normalizeList(JSON.parse(raw));
      return arr.length ? arr : null;  // 空数组等同缓存未就绪，触发等待/重试
    } catch (e) {}
    return null;
  }
  function loadShelfMeta() {
    if (shelfMetaLoading) return;
    shelfMetaLoading = true;
    var reqId = ++shelfMetaReqId, waits = 0;
    // ① 优先等 bundle 自己的请求把缓存写入（冷启动时通常 1~2 秒内完成），避免重复请求/鉴权竞态
    function waitCache() {
      var arr = readBooksFromCache();
      if (arr && arr.length) { finishMeta(arr, reqId); return; }
      if (++waits <= 6) { setTimeout(waitCache, 400); return; }
      // ② 缓存始终缺失，按 bundle 的路径自行兜底请求一次
      var token = localStorage.getItem('lr_token') || localStorage.getItem('token') || '';
      fetch('/api/books?in_bookshelf=1&limit=1000', {
        credentials: 'include',
        headers: token ? { Authorization: 'Bearer ' + token } : {}
      }).then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; })
        .then(function (data) {
          var arr2 = normalizeList(data);
          if (arr2.length) {
            try { sessionStorage.setItem(BS_CACHE_KEY, JSON.stringify(arr2)); } catch (e) {}
          }
          finishMeta(arr2, reqId);
        });
    }
    waitCache();
  }
  function finishMeta(arr, reqId) {
    var token = localStorage.getItem('lr_token') || localStorage.getItem('token') || '';
    fetch('/api/stats/reading-progress?limit=500', {
      credentials: 'include',
      headers: token ? { Authorization: 'Bearer ' + token } : {}
    }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
      .then(function (progResp) {
        // 已有更新的请求在途时，本次结果作废
        if (reqId !== shelfMetaReqId) { shelfMetaLoading = false; return; }
        var prog = normalizeList(progResp);
        var progMap = new Map();
        prog.forEach(function (p) {
          if (!p) return;
          var id = p.book_id != null ? p.book_id : p.id;
          if (id != null) progMap.set(String(id), p);
        });
        var map = new Map();
        (arr || []).forEach(function (b) {
          if (!b) return;
          var key = String(b.id != null ? b.id : (b.book_id != null ? b.book_id : b.title));
          if (!key) return;
          // books 列表接口本身已 JOIN progress（书架卡片角标即用这些字段），直接采用；
          // reading-progress 接口返回的记录作为补充/覆盖
          var merged = {
            id: key,
            title: b.title,
            author: b.author || null,
            cover: b.cover || null,
            format: b.format || null,
            progress_percent: Number(b.progress_percent != null ? b.progress_percent
              : (b.percent != null ? b.percent : b.progress)) || 0,
            chapter_title: b.chapter_title || b.chapter || null,
            chapter_index: b.chapter_index != null ? b.chapter_index : (b.chapterIndex || 0),
            last_read: b.last_read || null
          };
          var p = progMap.get(key);
          if (!p && b.title) {
            // 兜底：按去扩展名的书名匹配进度记录
            for (var iter of progMap.values()) {
              if (iter.title && String(iter.title).replace(/\.[^.]+$/, '') === String(b.title).replace(/\.[^.]+$/, '')) {
                p = iter; break;
              }
            }
          }
          if (p) {
            var pp = Number(p.progress_percent != null ? p.progress_percent
              : (p.percent != null ? p.percent : p.progress)) || 0;
            if (pp > 0 || !merged.progress_percent) merged.progress_percent = pp;
            if (p.chapter_title || p.chapter) merged.chapter_title = p.chapter_title || p.chapter || null;
            if (p.chapter_index != null || p.chapterIndex != null) {
              merged.chapter_index = p.chapter_index != null ? p.chapter_index : (p.chapterIndex || 0);
            }
            merged.last_read = p.last_read || merged.last_read;
            if (!merged.author && p.author) merged.author = p.author;
          }
          map.set(key, merged);
          if (b.title) {
            map.set(String(b.title), merged);
            // React 渲染到 DOM 时会砍掉扩展名做显示名，额外存一份去扩展名的 key
            var stripped = String(b.title).replace(/\.(epub|txt|mobi|pdf|azw3|fb2|cbz|cbr|cb7)$/i, '');
            if (stripped !== String(b.title)) map.set(stripped, merged);
          }
        });
        shelfMetaMap = map;
        shelfMetaAt = Date.now();
        shelfMetaLoading = false;
        // 空结果但 DOM 里明明有书（冷启动竞态/瞬时鉴权失败）：限时重试，避免空 Map 被 TTL 冻结
        var hasDomTitles = !!document.querySelector('[data-qy-title]');
        if (!map.size && hasDomTitles && shelfMetaEmptyRetries < SHELF_META_EMPTY_MAX) {
          shelfMetaEmptyRetries++;
          setTimeout(function () { try { loadShelfMeta(); } catch (e) {} }, 1500);
        } else if (map.size) {
          shelfMetaEmptyRetries = 0;
        }
        try { enrichListMeta(); } catch (e) {}
      });
  }
  function truncate(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n) + '…' : s;
  }
  function buildMetaLine(b) {
    var author = b.author ? truncate(b.author, 10) : '佚名';
    var p = Math.round(Number(b.progress_percent) || 0);
    var prog = p >= 95 ? '已读完' : (p > 0 ? p + '%' : '未读');
    var chap;
    if (p === 0) chap = '未开始阅读';
    else if (b.chapter_title) chap = '读到 ' + truncate(b.chapter_title, 14);
    else chap = '第 ' + ((b.chapter_index || 0) + 1) + ' 章';
    return '✍ ' + author + '　📖 ' + chap + '　' + prog;
  }
  // 从卡片 DOM 反查 book id：封面 img 的 src 可能含 /api/books/:id/cover，
  // 标题文本作兜底（重名时可能错，但 enhancer 不是强类型渲染，能跑就行）
  function resolveBookId(card, titleEl) {
    var img = card.querySelector('img[src*="/cover"]');
    if (img && img.src) {
      var m = img.src.match(/\/api\/books\/(\d+)\/cover/);
      if (m) return m[1];
      m = img.src.match(/book_id=(\d+)/);
      if (m) return m[1];
    }
    // 封面没 img（可能是纯色块 fallback），找最近一个带数字 href 的 <a>
    var link = card.querySelector('a[href*="/read/"]');
    if (link) {
      var mm = link.getAttribute('href').match(/\/read\/(\d+)/);
      if (mm) return mm[1];
    }
    return titleEl.getAttribute('data-qy-name') || (titleEl.textContent || '').trim();
  }
  function enrichListMeta() {
    if (getShelfView() !== 'list') return;
    var titles = $all('[data-qy-title]');
    if (!titles.length) return;
    var need = (!shelfMetaMap || Date.now() - shelfMetaAt > SHELF_META_TTL) && !shelfMetaLoading;
    if (!shelfMetaMap && shelfMetaLoading) return;
    if (need) { loadShelfMeta(); return; }
    if (!shelfMetaMap) return;
    titles.forEach(function (titleEl) {
      var card = titleEl.closest ? titleEl.closest('[data-qy-card]') : null;
      var name = titleEl.getAttribute('data-qy-name');
      if (name == null) {
        name = (titleEl.textContent || '').trim();
        titleEl.setAttribute('data-qy-name', name);
      }
      // 首次：把原书名文本包进 .qy-book-name，第二行留给 meta
      if (!titleEl.querySelector('.qy-book-name')) {
        titleEl.textContent = '';
        var s = document.createElement('span');
        s.className = 'qy-book-name';
        s.textContent = name;
        titleEl.appendChild(s);
      }
      var key = card ? resolveBookId(card, titleEl) : name;
      var strippedName = String(name).replace(/\.(epub|txt|mobi|pdf|azw3|fb2|cbz|cbr|cb7)$/i, '');
      var b = shelfMetaMap.get(key) || shelfMetaMap.get(name) || shelfMetaMap.get(strippedName);
      if (!b) {
        var oldMeta = titleEl.querySelector('.qy-book-meta');
        if (oldMeta && oldMeta.parentNode) oldMeta.parentNode.removeChild(oldMeta);
        return;
      }
      var line = buildMetaLine(b);
      var meta = titleEl.querySelector('.qy-book-meta');
      if (!meta) {
        meta = document.createElement('div');
        meta.className = 'qy-book-meta';
        titleEl.appendChild(meta);
      }
      if (meta.textContent !== line) meta.textContent = line;
    });
  }

  /* ---- 书架元数据自动刷新：从阅读页返回书架/首页时强制刷新 ---- */
  function forceShelfRefresh() {
    try { sessionStorage.removeItem(BS_CACHE_KEY); } catch (e) {}
    shelfMetaMap = null;
    shelfMetaAt = 0;
    shelfMetaLoading = false;
    shelfMetaReqId++;
    loadShelfMeta();
    try { enrichListMeta(); } catch (e) {}
  }
  var _shelfLastPath = location.pathname;
  var _shelfRefreshTimer = null;
  function _scheduleShelfRefresh(delay) {
    if (_shelfRefreshTimer) clearTimeout(_shelfRefreshTimer);
    _shelfRefreshTimer = setTimeout(function () {
      _shelfRefreshTimer = null;
      try { forceShelfRefresh(); } catch (e) {}
    }, delay);
  }
  function _shelfRouteEmit() {
    var cur = location.pathname;
    var wasReading = /^\/read\/\d+/.test(_shelfLastPath);
    var isReading = /^\/read\/\d+/.test(cur);
    _shelfLastPath = cur;
    // 从阅读页跳到非阅读页（返回书架/首页）→ 触发刷新
    if (wasReading && !isReading) _scheduleShelfRefresh(800);
  }
  (function initShelfRouteListener() {
    var _push = history.pushState, _replace = history.replaceState;
    history.pushState = function () { var r = _push.apply(this, arguments); _shelfRouteEmit(); return r; };
    history.replaceState = function () { var r = _replace.apply(this, arguments); _shelfRouteEmit(); return r; };
    window.addEventListener('popstate', _shelfRouteEmit);
    // 页面从隐藏到可见时，若不在阅读页且距上次拉取超过 5 秒，触发刷新
    function onVisible() {
      if (document.visibilityState && document.visibilityState !== 'visible') return;
      if (/^\/read\/\d+/.test(location.pathname)) return;
      if (Date.now() - shelfMetaAt > 5000) _scheduleShelfRefresh(300);
    }
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
  })();

  /* ===================== 4g. 阅读器白噪音（仅 /read/:id 页面，WebAudio 纯合成，无音频文件） ===================== */
  var WN_KEY_SOUND = 'qy_wn_sound';
  var WN_KEY_VOL = 'qy_wn_volume';
  var WN_KEY_POS = 'qy_wn_btn_pos';
  var WN_KEY_RATE = 'qy_wn_rate';
  var WN_SOUNDS = [
    { id: 'white', name: '白噪音' },
    { id: 'pink',  name: '粉噪音' },
    { id: 'brown', name: '棕噪音' },
    { id: 'rain',  name: '雨声' },
    { id: 'ocean', name: '海浪' },
    { id: 'fire',  name: '篝火' }
  ];
  var wnCtx = null, wnMaster = null, wnBufs = null, wnBag = null, wnActive = null;
  var wnPanelOpen = false, wnLastReading = false, wnUI = null;

  function wnVol() {
    var v = parseFloat(localStorage.getItem(WN_KEY_VOL));
    return (!isNaN(v) && v >= 0 && v <= 1) ? v : 0.6;
  }
  function wnAudio() {
    if (!wnCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      wnCtx = new AC();
      wnMaster = wnCtx.createGain();
      wnMaster.gain.value = 0;
      wnMaster.connect(wnCtx.destination);
    }
    if (wnCtx.state === 'suspended') { wnCtx.resume(); }
    return wnCtx;
  }
  // 预生成 2 秒循环噪声缓冲（白 / 粉 / 棕），粉棕按峰值归一避免音量差异过大
  function wnGetBufs() {
    if (wnBufs) return wnBufs;
    var sr = wnCtx.sampleRate, len = sr * 2;
    function mk(fill) {
      var buf = wnCtx.createBuffer(1, len, sr), d = buf.getChannelData(0), peak = 0.0001, i, v;
      for (i = 0; i < len; i++) { v = fill(i, d); d[i] = v; if (v > peak) peak = v; if (-v > peak) peak = -v; }
      if (fill._normalize) for (i = 0; i < len; i++) d[i] = d[i] / peak * 0.9;
      return buf;
    }
    var white = mk(function () { return Math.random() * 2 - 1; });
    var pinkFill = (function () {
      var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      var f = function () {
        var w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99683 * b1 + w * 0.0750759;
        b2 = 0.95000 * b2 + w * 0.1538520;
        b3 = 0.85000 * b3 + w * 0.3104856;
        b4 = 0.70000 * b4 + w * 0.5329522;
        b5 = -0.75 * b5 - w * 0.0168980;
        var out = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
        b6 = w * 0.115926;
        return out * 0.11;
      };
      f._normalize = true;
      return f;
    })();
    var brownFill = (function () {
      var last = 0;
      var f = function () {
        var w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        return last * 3.5;
      };
      f._normalize = true;
      return f;
    })();
    wnBufs = { white: white, pink: mk(pinkFill), brown: mk(brownFill) };
    return wnBufs;
  }
  function wnLoop(buf) {
    var s = wnCtx.createBufferSource();
    s.buffer = buf; s.loop = true;
    return s;
  }
  // LFO：oscFreq → 深度 → 目标参数（返回 osc/g 两个节点，拆图时一并断开）
  function wnLfo(freq, depth, target) {
    var osc = wnCtx.createOscillator(), g = wnCtx.createGain();
    osc.frequency.value = freq; g.gain.value = depth;
    osc._baseFreq = freq;  // 供播放速度调整时按比例缩放
    osc.connect(g); g.connect(target);
    osc.start();
    return { osc: osc, g: g };
  }
  function wnBuild(id) {
    var bufs = wnGetBufs(), nodes = [], out = wnCtx.createGain();
    out.gain.value = 1; out.connect(wnMaster);
    var src, filt, g;
    if (id === 'white') {
      src = wnLoop(bufs.white); src.connect(out); nodes.push(src);
    } else if (id === 'pink') {
      src = wnLoop(bufs.pink); src.connect(out); nodes.push(src);
    } else if (id === 'brown') {
      src = wnLoop(bufs.brown);
      filt = wnCtx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 420;
      src.connect(filt); filt.connect(out); nodes.push(src);
    } else if (id === 'rain') {
      src = wnLoop(bufs.white);
      var hp = wnCtx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 480;
      var bp = wnCtx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1700; bp.Q.value = 0.4;
      g = wnCtx.createGain(); g.gain.value = 0.62;
      src.connect(hp); hp.connect(bp); bp.connect(g); g.connect(out);
      // 两层慢 LFO 模拟雨声起伏
      var rainLfo1 = wnLfo(0.31, 0.22, g.gain), rainLfo2 = wnLfo(0.93, 0.10, g.gain);
      nodes.push(rainLfo1.osc, rainLfo1.g, rainLfo2.osc, rainLfo2.g, src);
    } else if (id === 'ocean') {
      src = wnLoop(bufs.brown);
      filt = wnCtx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 420;
      g = wnCtx.createGain(); g.gain.value = 0.6;
      src.connect(filt); filt.connect(g); g.connect(out);
      // 约 11 秒一次潮起潮落：同时调制滤波与音量
      var ocLfo1 = wnLfo(0.09, 300, filt.frequency), ocLfo2 = wnLfo(0.09, 0.32, g.gain);
      nodes.push(ocLfo1.osc, ocLfo1.g, ocLfo2.osc, ocLfo2.g, src);
    } else if (id === 'fire') {
      src = wnLoop(bufs.pink);
      filt = wnCtx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 620;
      g = wnCtx.createGain(); g.gain.value = 0.85;
      src.connect(filt); filt.connect(g); g.connect(out);
      nodes.push(src);
      // 随机噼啪声：自调度 setTimeout，间隔随播放速度调整
      var crackle = { _id: null };
      function firePop() {
        var interval = 130 / wnRate();
        crackle._id = setTimeout(function () {
          if (Math.random() <= 0.55) {
            try {
              var t = wnCtx.currentTime, pop = wnLoop(bufs.white);
              pop.loop = false;
              var pf = wnCtx.createBiquadFilter(); pf.type = 'bandpass';
              pf.frequency.value = 900 + Math.random() * 2600; pf.Q.value = 1.4;
              var pg = wnCtx.createGain();
              pg.gain.setValueAtTime(0, t);
              pg.gain.linearRampToValueAtTime(0.12 + Math.random() * 0.25, t + 0.006);
              pg.gain.exponentialRampToValueAtTime(0.001, t + 0.04 + Math.random() * 0.10);
              pop.connect(pf); pf.connect(pg); pg.connect(wnMaster);
              pop.start(t); pop.stop(t + 0.2);
            } catch (e) {}
          }
          firePop();
        }, interval);
      }
      firePop();
      nodes.push({ _timer: crackle, _isHandle: true });
    }
    return { out: out, nodes: nodes };
  }
  function wnPlay(id) {
    var ctx = wnAudio();
    if (!ctx) { toast('当前环境不支持背景音播放'); return; }
    wnTeardownBag();
    wnBag = wnBuild(id);
    wnBag.nodes.forEach(function (n) { if (n.start) { try { n.start(0); } catch (e) {} } });
    wnSetRate(wnRate());  // 应用当前播放速度
    wnActive = id;
    try { localStorage.setItem(WN_KEY_SOUND, id); } catch (e) {}
    // 淡入避免咔哒声
    var t = ctx.currentTime;
    wnMaster.gain.cancelScheduledValues(t);
    wnMaster.gain.setValueAtTime(Math.max(wnMaster.gain.value, 0.0001), t);
    wnMaster.gain.exponentialRampToValueAtTime(Math.max(wnVol(), 0.01), t + 0.8);
    wnRender();
  }
  function wnTeardownBag() {
    if (wnBag) {
      wnBag.nodes.forEach(function (n) {
        try {
          if (n._timer) {
            if (n._isHandle && n._timer._id != null) clearTimeout(n._timer._id);
            else clearInterval(n._timer);
          } else if (n.stop) n.stop();
        } catch (e) {}
        try { n.disconnect && n.disconnect(); } catch (e) {}
      });
      try { wnBag.out.disconnect(); } catch (e) {}
      wnBag = null;
    }
  }
  function wnStop(silent) {
    var ctx = wnCtx;
    if (ctx && wnBag) {
      var t = ctx.currentTime;
      try {
        wnMaster.gain.cancelScheduledValues(t);
        wnMaster.gain.setValueAtTime(Math.max(wnMaster.gain.value, 0.0001), t);
        wnMaster.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      } catch (e) {}
      var bag = wnBag;
      setTimeout(function () {
        // 淡出期间没有开始新音效才真正拆图
        if (wnBag === bag) wnTeardownBag();
      }, 480);
    }
    wnActive = null;
    wnRender();
  }
  function wnSetVol(v) {
    try { localStorage.setItem(WN_KEY_VOL, String(v)); } catch (e) {}
    if (wnCtx && wnActive) {
      wnMaster.gain.setTargetAtTime(v, wnCtx.currentTime, 0.05);
    }
  }
  function wnRate() {
    var v = parseFloat(localStorage.getItem(WN_KEY_RATE));
    return (!isNaN(v) && v >= 0.5 && v <= 2) ? v : 1.0;
  }
  function wnSetRate(v) {
    v = Math.max(0.5, Math.min(2, v));
    try { localStorage.setItem(WN_KEY_RATE, String(v)); } catch (e) {}
    if (wnBag) {
      wnBag.nodes.forEach(function (n) {
        try { if (n.playbackRate) n.playbackRate.value = v; } catch (e) {}          // BufferSource
        try { if (n._baseFreq && n.frequency) n.frequency.value = n._baseFreq * v; } catch (e) {}  // LFO 振荡器
      });
    }
  }
  function isReadingPath() {
    return /^\/read\/\d+/.test(location.pathname);
  }
  function wnBuildUI() {
    if (wnUI) return;
    var root = document.createElement('div');
    root.id = 'qy-wn';
    root.hidden = true;
    root.innerHTML =
      '<button type="button" class="qy-wn-fab" data-qy-wn-fab>🎧 白噪音</button>' +
      '<div class="qy-wn-panel" data-qy-wn-panel hidden>' +
        '<div class="qy-wn-row"><span class="qy-wn-title">阅读白噪音</span>' +
        '<button type="button" class="qy-wn-stop" data-qy-wn-stop title="停止">■</button>' +
        '<button type="button" class="qy-wn-x" data-qy-wn-x title="收起">×</button></div>' +
        '<div class="qy-wn-grid" data-qy-wn-grid></div>' +
        '<div class="qy-wn-vol"><span>音量</span><input type="range" min="0" max="1" step="0.05" data-qy-wn-vol>' +
        '<span data-qy-wn-volv></span></div>' +
        '<div class="qy-wn-rate"><span>速度</span><input type="range" min="0.5" max="2" step="0.1" data-qy-wn-rate>' +
        '<span data-qy-wn-ratev></span></div>' +
      '</div>';
    var st = document.createElement('style');
    st.id = 'qy-wn-style';
    st.textContent =
      '#qy-wn{position:fixed;z-index:99990;font-family:inherit;-webkit-tap-highlight-color:transparent;' +
        'transition:left .18s ease,right .18s ease,top .18s ease}' +
      '#qy-wn.qy-wn-dragging{transition:none}' +
      '#qy-wn .qy-wn-fab{border:none;border-radius:999px;padding:8px 14px;font-size:13px;line-height:1;color:#fff;' +
        'background:rgba(0,0,0,.55);backdrop-filter:blur(6px);box-shadow:0 2px 10px rgba(0,0,0,.28);cursor:grab;' +
        'user-select:none;-webkit-user-select:none;touch-action:none;animation:qyWnFloat 3s ease-in-out infinite}' +
      '@keyframes qyWnFloat{0%,100%{transform:translateY(0);box-shadow:0 2px 10px rgba(0,0,0,.28)}' +
        '50%{transform:translateY(-6px);box-shadow:0 10px 22px rgba(51,112,255,.30)}}' +
      '#qy-wn .qy-wn-fab.on{background:rgba(51,112,255,.95)}' +
      '#qy-wn .qy-wn-fab.dragging{animation:none;cursor:grabbing;opacity:.85;box-shadow:0 8px 20px rgba(0,0,0,.22)}' +
      '#qy-wn .qy-wn-panel{position:absolute;top:calc(100% + 8px);width:224px;box-sizing:border-box;' +
        'background:rgba(28,28,30,.94);color:#f2f2f2;border-radius:14px;padding:12px;' +
        'box-shadow:0 8px 28px rgba(0,0,0,.38);backdrop-filter:blur(8px)}' +
      '#qy-wn .qy-wn-row{display:flex;align-items:center;margin-bottom:8px}' +
      '#qy-wn .qy-wn-title{flex:1;font-size:12px;opacity:.72}' +
      '#qy-wn .qy-wn-stop,#qy-wn .qy-wn-x{border:none;background:none;color:#ccc;font-size:14px;cursor:pointer;padding:0 6px;line-height:1}' +
      '#qy-wn .qy-wn-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:10px}' +
      '#qy-wn .qy-wn-grid button{border:1px solid rgba(255,255,255,.18);background:transparent;color:#eee;' +
        'border-radius:8px;padding:7px 0;font-size:12px;cursor:pointer}' +
      '#qy-wn .qy-wn-grid button.on{background:#3370ff;border-color:#3370ff;color:#fff}' +
      '#qy-wn .qy-wn-vol,#qy-wn .qy-wn-rate{display:flex;align-items:center;gap:8px;font-size:11px;opacity:.85}' +
      '#qy-wn .qy-wn-rate{margin-top:6px}' +
      '#qy-wn .qy-wn-vol input,#qy-wn .qy-wn-rate input{flex:1;min-width:0}' +
      '#qy-wn .qy-wn-vol span:last-child,#qy-wn .qy-wn-rate span:last-child{width:30px;text-align:right}' +
      '@media (prefers-reduced-motion:reduce){#qy-wn .qy-wn-fab{animation:none;box-shadow:0 2px 10px rgba(0,0,0,.28)}}';

    var grid = root.querySelector('[data-qy-wn-grid]');
    WN_SOUNDS.forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button'; b.setAttribute('data-qy-wn-sound', s.id); b.textContent = s.name;
      b.addEventListener('click', function () {
        if (wnActive === s.id) wnStop(); else wnPlay(s.id);
      });
      grid.appendChild(b);
    });
    root.querySelector('[data-qy-wn-x]').addEventListener('click', function () {
      wnPanelOpen = false; wnRender();
    });
    root.querySelector('[data-qy-wn-stop]').addEventListener('click', function () { wnStop(); });
    var slider = root.querySelector('[data-qy-wn-vol]');
    slider.value = String(wnVol());
    root.querySelector('[data-qy-wn-volv]').textContent = Math.round(wnVol() * 100) + '';
    slider.addEventListener('input', function () {
      var v = parseFloat(slider.value) || 0;
      wnSetVol(v);
      root.querySelector('[data-qy-wn-volv]').textContent = Math.round(v * 100) + '';
    });
    var rateSlider = root.querySelector('[data-qy-wn-rate]');
    rateSlider.value = String(wnRate());
    root.querySelector('[data-qy-wn-ratev]').textContent = wnRate().toFixed(1) + 'x';
    rateSlider.addEventListener('input', function () {
      var v = parseFloat(rateSlider.value) || 1;
      wnSetRate(v);
      root.querySelector('[data-qy-wn-ratev]').textContent = v.toFixed(1) + 'x';
    });

    // 浮动按钮拖拽 + 位置持久化（复用小说下载按钮模式）
    var WN_M = 12, WN_DRAG_THRESHOLD = 8;
    function wnLoadPos() {
      try { return JSON.parse(localStorage.getItem(WN_KEY_POS)) || {}; } catch (e) { return {}; }
    }
    function wnClampTop(top) {
      var fabEl = root.querySelector('.qy-wn-fab');
      var hh = fabEl ? fabEl.offsetHeight : 36;
      var max = window.innerHeight - hh - WN_M;
      return Math.round(Math.max(WN_M, Math.min(top, Math.max(WN_M, max))));
    }
    function wnApplySide(side) {
      if (side === 'left') {
        root.style.left = 'max(' + WN_M + 'px, env(safe-area-inset-left))';
        root.style.right = 'auto';
      } else {
        root.style.right = 'max(' + WN_M + 'px, env(safe-area-inset-right))';
        root.style.left = 'auto';
      }
      var panel = root.querySelector('.qy-wn-panel');
      if (panel) {
        panel.style.right = side === 'right' ? '0' : 'auto';
        panel.style.left = side === 'left' ? '0' : 'auto';
      }
    }
    function wnPlace(animate) {
      var p = wnLoadPos();
      var side = p.side === 'left' ? 'left' : 'right';
      var fabEl = root.querySelector('.qy-wn-fab');
      if (!animate) root.classList.add('qy-wn-dragging');
      wnApplySide(side);
      if (typeof p.top === 'number') {
        root.style.top = wnClampTop(p.top) + 'px';
        root.style.bottom = 'auto';
      } else {
        // 初始位置：页面垂直居中
        var hh = fabEl ? fabEl.offsetHeight : 36;
        root.style.top = Math.round(window.innerHeight / 2 - hh / 2) + 'px';
        root.style.bottom = 'auto';
      }
      if (!animate) requestAnimationFrame(function () { root.classList.remove('qy-wn-dragging'); });
    }

    var fab = root.querySelector('.qy-wn-fab');
    var sx, sy, startLeft, startTop, dragging, w, h;
    fab.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      var r = root.getBoundingClientRect();
      w = r.width; h = r.height;
      sx = e.clientX; sy = e.clientY;
      startLeft = r.left; startTop = r.top;
      dragging = false;
      fab.clicked = false;
      fab.setPointerCapture && fab.setPointerCapture(e.pointerId);
    });
    fab.addEventListener('pointermove', function (e) {
      if (sx === undefined) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (!dragging && Math.max(Math.abs(dx), Math.abs(dy)) < WN_DRAG_THRESHOLD) return;
      if (!dragging) {
        dragging = true;
        fab.classList.add('dragging');
        root.classList.add('qy-wn-dragging');
        root.style.right = 'auto';
        wnPanelOpen = false; wnRender();  // 拖拽时收起面板
      }
      var nl = Math.max(WN_M, Math.min(window.innerWidth - w - WN_M, startLeft + dx));
      var nt = wnClampTop(startTop + dy);
      root.style.left = nl + 'px';
      root.style.top = nt + 'px';
    });
    function wnEndDrag() {
      if (sx === undefined) return;
      if (dragging) {
        var r = root.getBoundingClientRect();
        var side = (r.left + w / 2) < (window.innerWidth / 2) ? 'left' : 'right';
        var top = wnClampTop(r.top);
        try { localStorage.setItem(WN_KEY_POS, JSON.stringify({ side: side, top: top })); } catch (err) {}
        fab.classList.remove('dragging');
        root.classList.remove('qy-wn-dragging');
        wnApplySide(side);
        root.style.top = top + 'px';
      } else {
        // 短按（未达拖拽阈值）切换面板
        if (!fab.clicked) { fab.clicked = true; wnPanelOpen = !wnPanelOpen; wnRender(); setTimeout(function () { fab.clicked = false; }, 200); }
      }
      sx = sy = undefined;
    }
    fab.addEventListener('pointerup', wnEndDrag);
    fab.addEventListener('pointercancel', wnEndDrag);
    window.addEventListener('resize', function () { wnPlace(true); });

    // 全部就绪后再上屏，避免中途异常残留半成品 DOM
    document.documentElement.appendChild(st);
    document.body.appendChild(root);
    wnPlace(false);
    wnUI = root;
  }
  function wnRender() {
    if (!wnUI) return;
    wnUI.hidden = !wnLastReading;
    wnUI.querySelector('[data-qy-wn-fab]').classList.toggle('on', !!wnActive);
    wnUI.querySelector('[data-qy-wn-fab]').textContent = wnActive
      ? '🎵 ' + (WN_SOUNDS.filter(function (s) { return s.id === wnActive; })[0] || {}).name
      : '🎧 白噪音';
    wnUI.querySelector('[data-qy-wn-panel]').hidden = !wnPanelOpen;
    Array.prototype.forEach.call(wnUI.querySelectorAll('[data-qy-wn-sound]'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-qy-wn-sound') === wnActive);
    });
  }
  // 进入/离开阅读页的总同步：离开时自动停止并隐藏入口
  function wnSyncView() {
    var reading = isReadingPath();
    if (reading === wnLastReading) return;
    wnLastReading = reading;
    if (reading) {
      wnBuildUI();
      wnRender();
    } else {
      if (wnActive) { wnStop(true); }
      wnPanelOpen = false;
      wnRender();
    }
  }
  (function initWnRouter() {
    function emit() { try { wnSyncView(); } catch (e) {} }
    var _push = history.pushState, _replace = history.replaceState;
    history.pushState = function () { var r = _push.apply(this, arguments); emit(); return r; };
    history.replaceState = function () { var r = _replace.apply(this, arguments); emit(); return r; };
    window.addEventListener('popstate', emit);
    // 兜底：部分跳转可能不经 history API，每秒校正一次
    setInterval(emit, 1000);
    emit();
  })();

  /* ===================== 5. AI / 成就中心真删（v0.1.2） ===================== */
  // 精确匹配的独立入口文本（移除了 '语音配置'——TTS 恢复后继续保留；保留了 AI 相关）
  var CONCEAL_EXACT = ['我的成就', '阅读洞察', 'AI记忆管理', 'AI配置', '成就配置', 'AI 智能语境解析', 'AI补全', 'AI补全中…', 'AI补全成功'];
  // 前缀匹配：严格限定只匹配 AI 相关，避免误伤其他"对话"tab 或带"AI"字的正常功能
  var CONCEAL_PREFIX = ['AI补全'];

  function conceal(el) {
    if (!el || el.getAttribute('data-qy-off')) return;
    el.setAttribute('data-qy-off', '1');
    el.style.setProperty('display', 'none', 'important');
  }

  function concealTabButton(el) {
    // 管理中心 tab 按钮通常是 <button> 或带 role="tab" 的元素
    var btn = el;
    for (var i = 0; i < 3 && btn; i++) {
      if (btn.tagName && (btn.tagName === 'BUTTON' || btn.tagName === 'A') ||
          (btn.getAttribute && btn.getAttribute('role') === 'tab') ||
          (btn.getAttribute && btn.getAttribute('role') === 'button')) {
        conceal(btn);
        return;
      }
      btn = btn.parentElement;
    }
    // 找不到按钮容器就 conceal 这个文本的父元素
    conceal(el.parentElement || el);
  }

  function concealFromText(el) {
    var btn = el.closest ? el.closest('button,a,[role="button"],[role="tab"]') : null;
    if (btn) { conceal(btn); return; }
    var row = el;
    for (var i = 0; i < 4; i++) {
      var p = row.parentElement;
      if (!p) break;
      // 管理中心 tab 容器特征：同一个父级还有 text / icon / arrow 等子节点
      if (p.children && p.children.length >= 2) { row = p; break; }
      row = p;
    }
    conceal(row);
  }

  // 落地页简介改写
  function rewriteLandingCopy() {
    var ps = $all('p');
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      if (p.getAttribute('data-qy-land')) continue;
      var t = p.textContent || '';
      if (t.indexOf('AI 听书与批注笔记') !== -1 || t.indexOf('AI助手、批注笔记') !== -1) {
        p.setAttribute('data-qy-land', '1');
        p.textContent = '飞牛上的私人书库与阅读中心：多格式书库管理、小说搜索下载、沉浸阅读与批注笔记，所有数据仅保存在你的 NAS 本机。';
      } else if (t.indexOf('成就系统与一键分享') !== -1 || t.indexOf('AI助手、成就、分享') !== -1 || t.indexOf('成就 / 分享') !== -1) {
        p.setAttribute('data-qy-land', '1');
        p.textContent = '飞牛上的私人书库与阅读中心：多格式书库管理、小说搜索下载、沉浸阅读、AI听书与批注笔记，所有数据仅保存在你的 NAS 本机。';
      }
    }
  }

  function scanConcealEntries(rootNode) {
    var scope = rootNode && rootNode.nodeType === 1 ? rootNode : document.body;
    if (!scope) return;
    rewriteLandingCopy();
    var walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null);
    var hits = [];
    var n;
    while ((n = walker.nextNode())) {
      var raw = n.nodeValue;
      if (!raw || (raw.indexOf('A') === -1 && raw.indexOf('我') === -1 &&
          raw.indexOf('阅') === -1 && raw.indexOf('成') === -1)) continue;
      var s = raw.trim();
      if (!s) continue;
      var hit = CONCEAL_EXACT.indexOf(s) !== -1;
      if (!hit) { for (var i2 = 0; i2 < CONCEAL_PREFIX.length; i2++) { if (s.indexOf(CONCEAL_PREFIX[i2]) === 0) { hit = true; break; } } }
      // 只在管理中心 / 设置相关区域隐藏（避免误伤阅读页面里的中文）
      var pe = n.parentElement;
      if (!pe) continue;
      var inContext = !!(pe.closest && (pe.closest('[role="tablist"]') || pe.closest('[class*="ManagementCenter"]') || pe.closest('[class*="management"]') || pe.closest('[class*="settings"]') || pe.closest('[class*="Settings"]')));
      if (hit && inContext) hits.push(pe);
      // 精确匹配且文本短的直接全局隐藏（成就 / AI配置 这种）
      else if (hit && s.length <= 12) hits.push(pe);
    }
    for (var i3 = 0; i3 < hits.length; i3++) concealTabButton(hits[i3]);
  }

  /* ===================== DOM 观察 ===================== */
  var pending = false;
  function scheduleScan() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      try { tryInjectWidthRow(document); } catch (e) {}
      try { tryInjectDetailActions(); } catch (e) {}
      try { tryInjectShelfSwitch(); } catch (e) {}
      try { enrichListMeta(); } catch (e) {}
      try { neutralizeProfileCard(); } catch (e) {}
      try { injectAboutCredit(); } catch (e) {}
      try { injectUpdatePanel(); } catch (e) {}
      try { scanConcealEntries(document.body); } catch (e) {}
      try { startShellObserver(); } catch (e) {}
    });
  }
  new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      if (muts[i].addedNodes && muts[i].addedNodes.length) { scheduleScan(); break; }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  scheduleScan();
  // 冷启动阶段 React 异步渲染书架网格，前几次 scan 可能还没有卡片，
  // 用一个短定时器补扫，等首批 [data-qy-title] 出现后由 MutationObserver 接管。
  var shelfScanTimer = setInterval(function () {
    if (document.querySelector('[data-qy-title]')) { clearInterval(shelfScanTimer); return; }
    try { tryInjectShelfSwitch(); } catch (e) {}
    try { enrichListMeta(); } catch (e) {}
  }, 400);
  shelfScanTimer.unref && shelfScanTimer.unref();
  // 整页直接打开 /read/:id（冷启动场景，pushState 钩子来不及触发）
  try { setTimeout(checkAutoShelf, 300); } catch (e) {}
})();
