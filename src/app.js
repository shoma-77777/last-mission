/* ==========================================================================
   OPERATION LAST MISSION — app
   画面遷移・認証・カウントダウン・動画・戻る／再読み込み対策
   ※ このファイルは通常、編集不要です。内容の変更は src/config.js で行います。
   ========================================================================== */
(function () {
  'use strict';

  /* ---------- 設定 ---------- */
  var DEFAULTS = {
    passcode: 'LAST', hintAfterFailures: 3, hintText: '', targetCode: 'CODE 001', targetName: '',
    event: {}, letterParagraphs: [], finalMessage: 'これまで本当にありがとうございました。',
    videoFile: 'public/assets/final.mp4', videoPoster: '', photoFile: '', allowVideoSkip: false,
    countdownSeconds: 10, soundEnabled: true
  };
  var C = Object.assign({}, DEFAULTS, window.MISSION_CONFIG || {});
  C.event = C.event || {};
  C.countdownSeconds = Math.max(1, Math.min(99, parseInt(C.countdownSeconds, 10) || 10));

  var PAGES = ['access', 'auth', 'granted', 'erase', 'video', 'invite', 'complete'];
  var GOLD_PAGES = { invite: 1, complete: 1 };

  /* ---------- 小道具 ---------- */
  function $(id) { return document.getElementById(id); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function normalize(s) {
    s = String(s == null ? '' : s);
    try { s = s.normalize('NFKC'); } catch (e) { /* 古い端末 */ }
    return s.replace(/^[\s　]+|[\s　]+$/g, '').toUpperCase();
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 画面ごとの非同期処理を、画面を離れたら止めるための世代番号
  var gen = 0;
  var timers = [];
  function later(fn, ms) { var g = gen; var t = setTimeout(function () { if (g === gen) fn(); }, ms); timers.push(t); return t; }
  function wait(ms) { var g = gen; return new Promise(function (res, rej) { timers.push(setTimeout(function () { g === gen ? res() : rej('cancel'); }, ms)); }); }
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }
  function alive(g) { if (g !== gen) throw 'cancel'; }

  /* ---------- 保存（再読み込み対策） ---------- */
  var KEY = 'olm_progress_v1';
  var Store = {
    get: function () { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } },
    set: function (o) { try { localStorage.setItem(KEY, JSON.stringify(Object.assign(Store.get(), o))); } catch (e) { } },
    clear: function () { try { localStorage.removeItem(KEY); } catch (e) { } }
  };
  var state = Store.get();

  /* ---------- 効果音（Web Audio で生成。鳴らなくても進行に影響なし） ---------- */
  var Sound = {
    ctx: null,
    unlock: function () {
      if (C.soundEnabled === false) return;
      try {
        if (!this.ctx) { var A = window.AudioContext || window.webkitAudioContext; if (A) this.ctx = new A(); }
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
      } catch (e) { this.ctx = null; }
    },
    tone: function (f, dur, type, vol, when) {
      if (C.soundEnabled === false || !this.ctx) return;
      try {
        var t = this.ctx.currentTime + (when || 0);
        var o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.type = type || 'sine'; o.frequency.setValueAtTime(f, t);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(vol || 0.08, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g); g.connect(this.ctx.destination);
        o.start(t); o.stop(t + dur + 0.05);
      } catch (e) { }
    },
    click: function () { this.tone(620, 0.04, 'square', 0.025); },
    type: function () { this.tone(1800 + Math.random() * 400, 0.015, 'square', 0.012); },
    success: function () { this.tone(988, 0.11, 'sine', 0.12); this.tone(1319, 0.22, 'sine', 0.12, 0.11); },
    error: function () { this.tone(150, 0.18, 'square', 0.07); this.tone(110, 0.3, 'square', 0.07, 0.18); },
    tick: function (last) { this.tone(last ? 1400 : 1000, 0.07, 'square', 0.035); },
    boom: function () { this.tone(60, 0.9, 'sawtooth', 0.09); },
    chime: function () { this.tone(523, 0.8, 'sine', 0.06); this.tone(784, 0.9, 'sine', 0.05, 0.15); this.tone(1047, 1.2, 'sine', 0.04, 0.3); }
  };
  ['pointerdown', 'touchend', 'keydown'].forEach(function (ev) {
    document.addEventListener(ev, function () { Sound.unlock(); }, { passive: true });
  });
  function vibrate(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { } }

  /* ---------- 文字のタイプ演出 ---------- */
  function typeText(el, text, cps) {
    var g = gen;
    return new Promise(function (resolve, reject) {
      el.textContent = ''; el.classList.add('caret');
      var i = 0, step = 1000 / (cps || 40);
      (function next() {
        if (g !== gen) { el.textContent = text; el.classList.remove('caret'); return reject('cancel'); }
        i++;
        el.textContent = text.slice(0, i);

        if (i >= text.length) { el.classList.remove('caret'); return resolve(); }
        timers.push(setTimeout(next, step));
      })();
    });
  }
  // HTML を含む行は、文字だけ打ってから元のHTMLに戻す
  function typeLine(el, cps) {
    if (!el.dataset.html) el.dataset.html = el.innerHTML;
    var html = el.dataset.html;
    var tmp = document.createElement('div'); tmp.innerHTML = html;
    return typeText(el, tmp.textContent, cps).then(function () { el.innerHTML = html; }, function (e) { el.innerHTML = html; throw e; });
  }

  function toast(msg, ms) {
    var t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.hidden = true; }, ms || 2400);
  }

  /* ---------- 画面遷移 ---------- */
  var current = null;
  var busy = false;

  function guard(page) {
    if (PAGES.indexOf(page) < 0) page = 'access';
    if (PAGES.indexOf(page) >= 2 && !state.authed) page = 'auth';      // 未認証で先へ進ませない
    if (page === 'auth' && state.authed) page = 'granted';             // 認証済みなら入力画面に戻さない
    return page;
  }

  function show(page) {
    var prev = current;
    if (prev && Screens[prev] && Screens[prev].leave) Screens[prev].leave();
    gen++; clearTimers();
    Array.prototype.forEach.call(document.querySelectorAll('.screen'), function (s) { s.classList.remove('active'); });
    var el = $('screen-' + page);
    el.classList.add('active');
    document.body.classList.toggle('theme-gold', !!GOLD_PAGES[page]);
    document.body.classList.toggle('theme-intel', !GOLD_PAGES[page]);
    try { window.scrollTo(0, 0); } catch (e) { }
    current = page;
    if (Screens[page] && Screens[page].enter) Screens[page].enter();
  }

  // 映画のような切り替え（上下から閉じて、ラインが走り、開く）
  var txTimers = [];
  function cinematic(run, label, gold) {
    txTimers.forEach(clearTimeout); txTimers = [];
    var tx = $('tx');
    $('tx-text').textContent = label || '';
    tx.classList.toggle('gold', !!gold);
    tx.classList.remove('open', 'close');
    tx.classList.add('on');
    void tx.offsetWidth;
    tx.classList.add('close');
    txTimers.push(setTimeout(function () {
      run();
      tx.classList.remove('close'); tx.classList.add('open');
      txTimers.push(setTimeout(function () { tx.classList.remove('on', 'open'); busy = false; }, 420));
    }, 560));
  }

  function go(page, opts) {
    opts = opts || {};
    page = guard(page);
    if (busy && !opts.force) return;
    state.page = page; Store.set({ page: page });
    try {
      if (opts.replace) history.replaceState({ p: page }, '');
      else if (opts.push !== false) history.pushState({ p: page }, '');
    } catch (e) { }
    if (opts.instant) { show(page); return; }
    busy = true;
    cinematic(function () { show(page); }, opts.label, GOLD_PAGES[page]);
  }

  // ブラウザの「戻る」：前の画面に戻す（ただし未認証・認証画面の制御は guard で行う）
  window.addEventListener('popstate', function (e) {
    var p = e.state && e.state.p;
    if (!p) return;
    var target = guard(p);
    if (target !== p) { try { history.replaceState({ p: target }, ''); } catch (err) { } }
    if (target === current && !busy) return;
    busy = false;
    go(target, { push: false, force: true, label: '' });
  });

  /* ======================================================================
     各画面
     ====================================================================== */
  var Screens = {};

  /* ---------- BOOT ---------- */
  Screens.boot = {
    enter: function () {
      var g = gen;
      var bar = $('boot-bar');
      var resume = state.page && state.page !== 'access';
      $('boot-label').textContent = resume ? '通信を再開しています' : '通信を確立しています';
      var p = 0, start = Date.now();
      (function loop() {
        if (g !== gen) return;
        p = Math.min(100, p + Math.random() * 9 + 3);
        bar.style.width = p + '%';
        if (p >= 100 && Date.now() - start > 1600) {
          later(function () {
            var target = resume ? guard(state.page) : 'access';
            go(target, { replace: true, label: '' });
          }, 300);
          return;
        }
        later(loop, 90);
      })();
    }
  };

  /* ---------- PAGE 01 ---------- */
  Screens.access = {
    enter: function () {
      var g = gen;
      var lines = document.querySelectorAll('#access-log [data-type]');
      var reveals = document.querySelectorAll('#screen-access .reveal');
      Array.prototype.forEach.call(lines, function (l) { if (l.dataset.html) l.innerHTML = l.dataset.html; l.style.visibility = 'hidden'; });
      Array.prototype.forEach.call(reveals, function (r) { r.classList.remove('on'); });
      var chain = wait(250);
      Array.prototype.forEach.call(lines, function (l) {
        chain = chain.then(function () { alive(g); l.style.visibility = 'visible'; return typeLine(l, 22); }).then(function () { return wait(160); });
      });
      chain.then(function () {
        reveals[0].classList.add('on'); Sound.tone(110, 0.8, 'sine', 0.06);
        return wait(800);
      }).then(function () { reveals[1].classList.add('on'); }).catch(function () { });
    }
  };
  $('btn-init').addEventListener('click', function () {
    Sound.click(); go('auth', { label: '接続中' });
  });

  /* ---------- PAGE 02 ---------- */
  var failures = 0;
  // 暗証番号が数字だけなら、スマホで数字キーボードを出す
  if (/^[0-9]+$/.test(normalize(C.passcode))) {
    $('code-input').setAttribute('inputmode', 'numeric');
    $('code-input').setAttribute('pattern', '[0-9]*');
    $('code-input').setAttribute('autocapitalize', 'off');
  }
  // 暗証番号の枠（桁数ぶん）
  var CODE_LEN = Math.max(1, Math.min(12, normalize(C.passcode).length || 4));
  var CODE_NUMERIC = /^[0-9]+$/.test(normalize(C.passcode));
  if (CODE_NUMERIC) $('auth-label').textContent = '暗証番号（数字' + CODE_LEN + '桁）を入力してください。';
  $('code-slots').innerHTML = new Array(CODE_LEN + 1).join('<span class="code-slot"></span>');
  function renderSlots() {
    var v = $('code-input').value, slots = $('code-slots').children;
    for (var i = 0; i < slots.length; i++) {
      slots[i].textContent = v.charAt(i);
      slots[i].classList.toggle('filled', i < v.length);
      slots[i].classList.toggle('current', i === v.length);
    }
  }
  function cleanCode(s) {
    s = normalize(s).replace(/[\s　]/g, '');
    if (CODE_NUMERIC) s = s.replace(/[^0-9]/g, '');
    return s.slice(0, CODE_LEN);
  }
  $('code-input').addEventListener('input', function () {
    var c = cleanCode(this.value);
    if (c !== this.value) this.value = c;
    renderSlots();
  });
  // 枠のどこをタップしても入力できるように
  $('code-wrap').addEventListener('click', function () { try { $('code-input').focus(); } catch (e) { } });
  $('code-input').addEventListener('focus', function () { $('code-wrap').classList.add('focused'); renderSlots(); });
  $('code-input').addEventListener('blur', function () { $('code-wrap').classList.remove('focused'); });
  renderSlots();

  Screens.auth = {
    enter: function () {
      $('auth-error').hidden = true;
      $('code-input').value = '';
      renderSlots();
      $('btn-auth').disabled = false;
      // iOSではユーザー操作外のfocusでキーボードは出ないため、PCのみ自動フォーカス
      if (window.matchMedia && window.matchMedia('(pointer: fine)').matches) {
        later(function () { try { $('code-input').focus(); } catch (e) { } }, 400);
      }
    }
  };
  $('auth-form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy) return;
    var input = $('code-input');
    var value = normalize(input.value);
    var answer = normalize(C.passcode);
    if (!value) { input.focus(); return; }

    if (value === answer) {
      $('auth-error').hidden = true;
      $('btn-auth').disabled = true;
      try { input.blur(); } catch (err) { }
      Sound.success(); vibrate(40);
      state.authed = true; Store.set({ authed: true });
      setTimeout(function () { go('granted', { label: '照合中' }); }, 250);
    } else {
      failures++;
      var err = $('auth-error');
      err.hidden = true; void err.offsetWidth; err.hidden = false;
      var wrap = $('code-wrap');
      wrap.classList.remove('shake'); void wrap.offsetWidth; wrap.classList.add('shake');
      Sound.error(); vibrate([80, 40, 80]);
      later(function () { input.value = ''; renderSlots(); }, 450);
      if (C.hintAfterFailures > 0 && failures >= C.hintAfterFailures && C.hintText) {
        $('auth-hint').textContent = C.hintText; $('auth-hint').hidden = false;
      }
    }
  });
  $('code-wrap').addEventListener('animationend', function () { this.classList.remove('shake'); });
  $('code-input').addEventListener('input', function () { $('auth-error').hidden = true; });

  /* ---------- PAGE 03 ---------- */
  Screens.granted = {
    enter: function () {
      var g = gen;
      var stage = $('verify-stage'), panel = $('granted-panel'), rows = panel.querySelectorAll(':scope > div');
      var received = $('received');
      stage.classList.remove('scanning', 'granted');
      panel.classList.remove('on'); received.classList.remove('on');
      Array.prototype.forEach.call(rows, function (r) { r.classList.remove('on'); });
      $('verify-status').textContent = '照合中…';
      $('dl-progress').hidden = true; $('btn-download').disabled = false;
      void stage.offsetWidth;

      if (state.grantedSeen) { // 2回目以降は短縮
        stage.classList.add('granted');
        panel.classList.add('on');
        Array.prototype.forEach.call(rows, function (r) { r.classList.add('on'); });
        received.classList.add('on');
        return;
      }
      stage.classList.add('scanning');
      Sound.tone(220, 2.8, 'sine', 0.02);
      wait(3000).then(function () {
        alive(g);
        stage.classList.remove('scanning'); stage.classList.add('granted');
        Sound.success(); vibrate(30);
        return wait(700);
      }).then(function () {
        panel.classList.add('on');
        var chain = Promise.resolve();
        Array.prototype.forEach.call(rows, function (r) {
          chain = chain.then(function () { return wait(450); }).then(function () { r.classList.add('on'); Sound.click(); });
        });
        return chain;
      }).then(function () { return wait(500); }).then(function () {
        received.classList.add('on'); Sound.tone(660, 0.2, 'sine', 0.05);
        state.grantedSeen = true; Store.set({ grantedSeen: true });
      }).catch(function () { });
    }
  };
  $('btn-download').addEventListener('click', function () {
    if (busy || this.disabled) return;
    this.disabled = true; Sound.click();
    var g = gen, p = 0;
    $('dl-progress').hidden = false;
    (function step() {
      if (g !== gen) return;
      p = Math.min(100, p + Math.random() * 14 + 6);
      $('dl-bar').style.width = p + '%'; $('dl-pct').textContent = Math.floor(p);
      if (p >= 100) { later(function () { go('erase', { label: '' }); }, 350); return; }
      later(step, 110);
    })();
  });

  /* ---------- PAGE 04 ---------- */
  var cdInterval = null;
  Screens.erase = {
    enter: function () {
      var run = $('erase-run'), done = $('erase-done');
      if (state.erased) { run.hidden = true; done.hidden = false; return; }
      run.hidden = false; done.hidden = true;
      var total = C.countdownSeconds;
      var endAt = Date.now() + total * 1000;
      var cd = $('countdown'), bar = $('cd-bar');
      var shown = null;
      function render() {
        var ms = Math.max(0, endAt - Date.now());
        var sec = Math.ceil(ms / 1000);
        bar.style.width = (ms / (total * 1000) * 100) + '%';
        if (sec !== shown && sec > 0) {
          shown = sec;
          cd.textContent = pad2(sec);
          cd.classList.remove('tick'); void cd.offsetWidth; cd.classList.add('tick');
          Sound.tick(sec <= 3); if (sec <= 3) vibrate(30);
        }
        if (ms <= 0) finish();
      }
      function finish() {
        clearInterval(cdInterval); cdInterval = null;
        state.erased = true; Store.set({ erased: true });
        var bo = $('blackout');
        bo.classList.add('on'); Sound.boom(); vibrate(200);
        later(function () {
          run.hidden = true; done.hidden = false;
          try { window.scrollTo(0, 0); } catch (e) { }
          bo.classList.remove('on');
          Sound.tone(880, 0.3, 'sine', 0.05);
        }, 1800);
      }
      render();
      cdInterval = setInterval(render, 100);
    },
    leave: function () {
      if (cdInterval) { clearInterval(cdInterval); cdInterval = null; }
      $('blackout').classList.remove('on');
    }
  };
  $('btn-open-final').addEventListener('click', function () { Sound.click(); go('video', { label: '復号中' }); });

  /* ---------- PAGE 05 ---------- */
  var video = $('final-video');
  var videoReady = false;
  function revealConfirm() {
    $('btn-confirm').hidden = false;
    $('btn-skip').hidden = true;
    $('video-note').textContent = 'メッセージの受信が完了しました。';
  }
  function markMissing() {
    $('video-missing').hidden = false;
    $('play-overlay').hidden = true;
    $('video-loading').hidden = true;
    video.removeAttribute('controls');
    $('video-note').textContent = '動画が未設定のため、そのまま次へ進めます。';
    revealConfirm();
  }
  function initVideo() {
    if (videoReady) return;
    videoReady = true;
    $('video-path').textContent = C.videoFile;
    if (C.videoPoster) video.setAttribute('poster', C.videoPoster);

    video.addEventListener('loadedmetadata', function () { $('video-loading').hidden = true; });
    video.addEventListener('canplay', function () { $('video-loading').hidden = true; });
    video.addEventListener('error', function () { markMissing(); });
    video.addEventListener('play', function () { $('play-overlay').hidden = true; $('video-loading').hidden = true; });
    video.addEventListener('ended', function () {
      state.videoDone = true; Store.set({ videoDone: true });
      try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen(); } catch (e) { }
      try { if (video.webkitDisplayingFullscreen && video.webkitExitFullscreen) video.webkitExitFullscreen(); } catch (e) { }
      revealConfirm();
      Sound.tone(660, 0.25, 'sine', 0.05);
      setTimeout(function () { try { $('btn-confirm').scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { } }, 300);
    });

    // ファイルの有無を先に確認（file:// などで確認できない場合は video の error に任せる）
    var checked = false;
    if (window.fetch && location.protocol.indexOf('http') === 0) {
      fetch(C.videoFile, { method: 'HEAD', cache: 'no-store' }).then(function (r) {
        checked = true;
        var type = (r.headers.get('content-type') || '').toLowerCase();
        if (!r.ok || type.indexOf('text/html') >= 0) { markMissing(); return; }
        video.src = C.videoFile;
      }).catch(function () { if (!checked) video.src = C.videoFile; });
    } else {
      video.src = C.videoFile;
    }
    // 読み込み表示が残り続けないように
    setTimeout(function () { $('video-loading').hidden = true; }, 6000);
  }
  Screens.video = {
    enter: function () {
      $('video-to').textContent = C.targetCode;
      initVideo();
      if (state.videoDone) revealConfirm();
      else if (C.allowVideoSkip && $('video-missing').hidden) $('btn-skip').hidden = false;
    },
    leave: function () { try { video.pause(); } catch (e) { } }
  };
  $('play-overlay').addEventListener('click', function () {
    Sound.click();
    var overlay = this;
    try {
      var p = video.play();
      if (p && p.then) p.then(function () { overlay.hidden = true; }).catch(function () {
        overlay.hidden = true; // 自動で再生できなくても、標準の再生ボタンで操作できる
        toast('▶ ボタンをタップして再生してください');
      });
      else overlay.hidden = true;
    } catch (e) { overlay.hidden = true; }
  });
  $('btn-skip').addEventListener('click', function () { try { video.pause(); } catch (e) { } revealConfirm(); });
  $('btn-confirm').addEventListener('click', function () {
    try { video.pause(); } catch (e) { }
    Sound.click(); go('invite', { label: '' });
  });

  /* ---------- PAGE 06 ---------- */
  function buildInvite() {
    $('invite-code').textContent = C.targetCode;
    $('invite-name').textContent = C.targetName ? C.targetName + ' 殿' : '';
    $('invite-name').hidden = !C.targetName;

    $('letter').innerHTML = (C.letterParagraphs || []).map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('');

    var ev = C.event, rows = [
      ['作戦日時', ev.date],
      ['作戦場所', ev.venue, ev.address],
      ['作戦開始時刻', ev.meetingTime],
      ['ドレスコード', ev.dressCode],
      ['エージェント', ev.participants]
    ];
    $('info-list').innerHTML = rows.filter(function (r) { return r[1]; }).map(function (r) {
      return '<div><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + (r[2] ? '<small>' + esc(r[2]) + '</small>' : '') + '</dd></div>';
    }).join('');
    if (ev.mapUrl) { $('map-link').href = ev.mapUrl; $('map-link').hidden = false; }

    if (C.photoFile) {
      var img = $('invite-photo-img');
      img.onload = function () { $('invite-photo').hidden = false; };
      img.onerror = function () { $('invite-photo').hidden = true; };
      img.src = C.photoFile;
    }
  }
  buildInvite();
  Screens.invite = {
    enter: function () {
      var ps = document.querySelectorAll('#letter p');
      Array.prototype.forEach.call(ps, function (p) { p.classList.remove('on'); });
      Sound.chime();
      Array.prototype.forEach.call(ps, function (p, i) { later(function () { p.classList.add('on'); }, 700 + i * 650); });
    }
  };
  $('btn-accept').addEventListener('click', function () {
    Sound.click(); state.completed = true; Store.set({ completed: true });
    go('complete', { label: '' });
  });

  /* ---------- PAGE 07 ---------- */
  $('complete-code').textContent = C.targetCode;
  $('complete-name').textContent = C.targetName || '';
  $('complete-name').hidden = !C.targetName;
  $('complete-message').textContent = C.finalMessage;
  Screens.complete = {
    enter: function () {
      var lines = document.querySelectorAll('#screen-complete .c-line');
      Array.prototype.forEach.call(lines, function (l) { l.classList.remove('on'); });
      var delays = [400, 1600, 2000, 3300, 4400, 5400];
      Array.prototype.forEach.call(lines, function (l, i) {
        later(function () { l.classList.add('on'); if (i === 1) Sound.chime(); }, delays[i] || 5400);
      });
    }
  };
  $('btn-back-invite').addEventListener('click', function () { go('invite', { label: '' }); });
  $('btn-restart').addEventListener('click', function () {
    Store.clear(); state = {}; failures = 0;
    $('auth-hint').hidden = true;
    try { video.pause(); video.currentTime = 0; } catch (e) { }
    $('btn-confirm').hidden = true; $('play-overlay').hidden = !$('video-missing').hidden;
    $('video-note').textContent = '再生が終わると、次に進めます。';
    if (!$('video-missing').hidden) revealConfirm();
    go('access', { label: '' });
  });

  /* ---------- 開発用：?debug=1 で各画面へジャンプ ---------- */
  var params = new URLSearchParams(location.search);
  if (params.has('reset')) { Store.clear(); state = {}; }
  if (params.has('debug')) {
    var bar = document.createElement('div'); bar.className = 'debug-bar';
    PAGES.forEach(function (p, i) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = pad2(i + 1);
      b.onclick = function () { if (i >= 2) { state.authed = true; Store.set({ authed: true }); } busy = false; go(p, { force: true }); };
      bar.appendChild(b);
    });
    var r = document.createElement('button'); r.type = 'button'; r.textContent = 'RESET';
    r.onclick = function () { Store.clear(); location.href = location.pathname + '?debug=1'; };
    bar.appendChild(r);
    document.body.appendChild(bar);
  }

  /* ---------- 起動 ---------- */
  // 画面を閉じた／別アプリに切り替えた後に戻ってきてもカウントダウンは時刻基準で正しく進む
  try { history.replaceState({ p: 'boot' }, ''); } catch (e) { }
  show('boot');
})();
