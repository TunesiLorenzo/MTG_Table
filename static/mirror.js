/* The screen remote: the table screen live on a tablet, driven by touch.

   Pictures come from /api/mirror/frame.jpg one after another (the server
   answers 204 when nothing has changed). Fingers go back to
   /api/mirror/input in order, one request at a time, and the table PC plays
   them as its mouse:
     - a tap is a click, a hold is a held click, a drag is a mouse drag;
     - two fingers moving together scroll, like a mouse wheel.
   A first finger waits a moment before it presses, so that a second finger
   arriving turns the gesture into a scroll instead of a click. */
(function () {
  'use strict';

  var HOLD_MS = 90;
  var DRAG_PX = 10;
  var FRAME_GAP_MS = 40;
  var SAME_FRAME_MS = 70;
  var RETRY_MS = 1500;
  var WHEEL_PER_PX = 1.2;

  var key = new URLSearchParams(location.search).get('k') || '';
  var stage = document.getElementById('mirror');
  var screen = document.getElementById('mirror-screen');
  var status = document.getElementById('mirror-status');

  function $(id) { return document.getElementById(id); }

  function storeGet(name) {
    try { return window.localStorage.getItem(name); } catch (error) { return null; }
  }
  function storeSet(name, value) {
    try { window.localStorage.setItem(name, value); } catch (error) { /* private mode */ }
  }

  function showStatus(text, corner) {
    status.hidden = !text;
    status.textContent = text || '';
    status.classList.toggle('is-corner', !!corner);
  }

  /* ---- placing the picture ---- */
  var rotation = Number(storeGet('mirror-rotation')) || 0;
  var box = { width: 0, height: 0 };
  var region = { width: 0, height: 0 };

  /* The picture is fitted to the stage as it really is on screen. On Android
     Chrome window.innerHeight moves with the address bar while the stage does
     not always follow, which used to push every tap off by the bar's height. */
  function layout() {
    var naturalW = screen.naturalWidth, naturalH = screen.naturalHeight;
    if (!naturalW || !naturalH) return;
    var viewW = stage.clientWidth || window.innerWidth, viewH = stage.clientHeight || window.innerHeight;
    var turned = rotation % 180 !== 0;
    var scale = turned ? Math.min(viewW / naturalH, viewH / naturalW) : Math.min(viewW / naturalW, viewH / naturalH);
    box.width = naturalW * scale;
    box.height = naturalH * scale;
    screen.style.width = box.width + 'px';
    screen.style.height = box.height + 'px';
    screen.style.left = (viewW - box.width) / 2 + 'px';
    screen.style.top = (viewH - box.height) / 2 + 'px';
    screen.style.transform = 'rotate(' + rotation + 'deg)';
  }

  /* A point on the tablet as a fraction of the table screen, through the turn.
     Measured from the picture's centre where it actually is on screen (a
     turned box keeps its centre), never from where it is assumed to be. */
  function toTable(clientX, clientY) {
    var shown = screen.getBoundingClientRect();
    var dx = clientX - (shown.left + shown.width / 2), dy = clientY - (shown.top + shown.height / 2);
    var angle = rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
    var ux = dx * cos + dy * sin, uy = -dx * sin + dy * cos;
    return { x: ux / box.width + 0.5, y: uy / box.height + 0.5, uy: uy };
  }

  function inside(point) {
    return point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
  }

  function clamp(point) {
    return { x: Math.min(1, Math.max(0, point.x)), y: Math.min(1, Math.max(0, point.y)) };
  }

  window.addEventListener('resize', layout);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', layout);
  document.addEventListener('fullscreenchange', function () {
    layout();
    syncStart();
  });

  /* ---- pictures ---- */
  var lastFrame = '';
  var shownUrl = '';
  var stopped = false;

  function frameWidth() {
    var longest = Math.max(window.innerWidth, window.innerHeight) * (window.devicePixelRatio || 1);
    return Math.max(480, Math.min(1600, Math.round(longest)));
  }

  function later(ms) {
    window.setTimeout(nextFrame, ms);
  }

  function nextFrame() {
    if (stopped) return;
    if (document.hidden) return; // picked up again on visibilitychange
    var started = Date.now();
    var url = '/api/mirror/frame.jpg?k=' + encodeURIComponent(key) + '&w=' + frameWidth() +
      (lastFrame ? '&since=' + lastFrame : '');
    fetch(url, { cache: 'no-store' }).then(function (response) {
      var size = (response.headers.get('X-Region') || '').split('x');
      if (size.length === 2) {
        region.width = Number(size[0]) || region.width;
        region.height = Number(size[1]) || region.height;
      }
      if (response.status === 204) {
        later(SAME_FRAME_MS);
        return null;
      }
      if (!response.ok) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          var message = body.message || 'The table did not answer';
          if (response.status === 403) {
            stopped = true;
            showStatus(message);
          } else {
            showStatus(message);
            later(RETRY_MS * 2);
          }
        });
      }
      var found = response.headers.get('X-Table-Found') === '1';
      lastFrame = response.headers.get('X-Frame') || '';
      return response.blob().then(function (blob) {
        var next = URL.createObjectURL(blob);
        screen.onload = function () {
          if (shownUrl) URL.revokeObjectURL(shownUrl);
          shownUrl = next;
          layout();
          showStatus(found ? '' : 'The table page is not on the PC screen: showing the main screen', true);
          later(Math.max(0, FRAME_GAP_MS - (Date.now() - started)));
        };
        screen.onerror = function () {
          URL.revokeObjectURL(next);
          later(RETRY_MS);
        };
        screen.src = next;
      });
    }).catch(function () {
      showStatus('Lost the table. Reconnecting…');
      later(RETRY_MS);
    });
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) nextFrame();
  });

  /* ---- fingers out, in order ---- */
  var queue = [];
  var sending = false;

  function send(event) {
    var last = queue[queue.length - 1];
    if (last && last.type === 'move' && event.type === 'move') {
      queue[queue.length - 1] = event;
    } else if (last && last.type === 'wheel' && event.type === 'wheel') {
      last.amount = Math.max(-2400, Math.min(2400, last.amount + event.amount));
      last.x = event.x;
      last.y = event.y;
    } else {
      queue.push(event);
    }
    flush();
  }

  function flush() {
    if (sending || !queue.length) return;
    var events = queue.splice(0, 100);
    sending = true;
    fetch('/api/mirror/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ k: key, events: events })
    }).then(function (response) {
      if (response.ok) return;
      return response.json().catch(function () { return {}; }).then(function (body) {
        showStatus(body.message || 'The table did not take that', true);
      });
    }).catch(function () {
      showStatus('Lost the table. Reconnecting…', true);
    }).then(function () {
      sending = false;
      flush();
    });
  }

  function ripple(clientX, clientY) {
    var ring = document.createElement('span');
    ring.className = 'mirror__ripple';
    ring.style.left = clientX + 'px';
    ring.style.top = clientY + 'px';
    document.body.appendChild(ring);
    window.setTimeout(function () { ring.remove(); }, 450);
  }

  /* ---- gestures ---- */
  var fingers = new Map();
  var gesture = { mode: 'idle', id: null, start: null, startClient: null, timer: null, scrollY: 0 };

  function middle() {
    var x = 0, y = 0;
    fingers.forEach(function (point) { x += point.x; y += point.y; });
    return { x: x / fingers.size, y: y / fingers.size };
  }

  function press() {
    window.clearTimeout(gesture.timer);
    gesture.mode = 'press';
    send({ type: 'down', x: gesture.start.x, y: gesture.start.y });
    var now = fingers.get(gesture.id);
    if (now) {
      var point = clamp(toTable(now.x, now.y));
      if (point.x !== gesture.start.x || point.y !== gesture.start.y) send({ type: 'move', x: point.x, y: point.y });
    }
  }

  stage.addEventListener('pointerdown', function (event) {
    if (!box.width) return;
    event.preventDefault();
    try { stage.setPointerCapture(event.pointerId); } catch (error) { /* already gone */ }
    fingers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    closeMenu();

    if (fingers.size === 1) {
      var point = toTable(event.clientX, event.clientY);
      if (!inside(point)) {
        gesture.mode = 'outside';
        return;
      }
      gesture.mode = 'pending';
      gesture.id = event.pointerId;
      gesture.start = { x: point.x, y: point.y };
      gesture.startClient = { x: event.clientX, y: event.clientY };
      gesture.timer = window.setTimeout(press, HOLD_MS);
      ripple(event.clientX, event.clientY);
    } else if (fingers.size === 2 && gesture.mode === 'pending') {
      window.clearTimeout(gesture.timer);
      gesture.mode = 'scroll';
      var centre = middle();
      gesture.scrollY = toTable(centre.x, centre.y).uy;
    }
  });

  stage.addEventListener('pointermove', function (event) {
    if (!fingers.has(event.pointerId)) return;
    fingers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (gesture.mode === 'pending' && event.pointerId === gesture.id) {
      var far = Math.hypot(event.clientX - gesture.startClient.x, event.clientY - gesture.startClient.y);
      if (far > DRAG_PX) press();
      return;
    }
    if (gesture.mode === 'press' && event.pointerId === gesture.id) {
      var point = clamp(toTable(event.clientX, event.clientY));
      send({ type: 'move', x: point.x, y: point.y });
    } else if (gesture.mode === 'scroll' && fingers.size >= 2) {
      var centre = middle();
      var at = toTable(centre.x, centre.y);
      var moved = at.uy - gesture.scrollY;
      var amount = Math.round(moved / box.height * (region.height || screen.naturalHeight) * WHEEL_PER_PX);
      if (amount) {
        // Kept to the part actually sent, so rounding never drifts.
        gesture.scrollY += amount / WHEEL_PER_PX / (region.height || screen.naturalHeight) * box.height;
        var spot = clamp(at);
        send({ type: 'wheel', x: spot.x, y: spot.y, amount: amount });
      }
    }
  });

  function lift(event) {
    if (!fingers.has(event.pointerId)) return;
    var last = fingers.get(event.pointerId);
    fingers.delete(event.pointerId);
    var cancelled = event.type === 'pointercancel';

    if (event.pointerId === gesture.id && gesture.mode === 'pending') {
      window.clearTimeout(gesture.timer);
      if (!cancelled) {
        send({ type: 'down', x: gesture.start.x, y: gesture.start.y });
        send({ type: 'up', x: gesture.start.x, y: gesture.start.y });
      }
      gesture.mode = 'idle';
    } else if (event.pointerId === gesture.id && gesture.mode === 'press') {
      var point = clamp(toTable(last.x, last.y));
      send({ type: 'up', x: point.x, y: point.y });
      gesture.mode = 'done';
    }
    if (!fingers.size) gesture.mode = 'idle';
  }

  stage.addEventListener('pointerup', lift);
  stage.addEventListener('pointercancel', lift);
  stage.addEventListener('contextmenu', function (event) { event.preventDefault(); });

  /* ---- full screen, in the table's own orientation ----
     Android Chrome only goes full screen after a tap, so the first screen
     asks for one. With the bars gone and the phone turned to match the
     table screen, the picture fills it. */
  function wideTable() {
    var width = region.width || screen.naturalWidth, height = region.height || screen.naturalHeight;
    return !height || width >= height;
  }

  function goFullScreen() {
    var root = document.documentElement;
    var request = root.requestFullscreen || root.webkitRequestFullscreen;
    if (!request) return Promise.resolve(false);
    return Promise.resolve(request.call(root)).then(function () {
      var orientation = window.screen && window.screen.orientation;
      if (!orientation || !orientation.lock) return true;
      return orientation.lock(wideTable() ? 'landscape' : 'portrait').then(function () {
        // The phone is turned now: the picture no longer needs turning.
        rotation = 0;
        storeSet('mirror-rotation', '0');
        layout();
        return true;
      }).catch(function () { return true; });
    }).catch(function () { return false; });
  }

  var start = $('mirror-start');

  function canFullScreen() {
    var root = document.documentElement;
    return !!(root.requestFullscreen || root.webkitRequestFullscreen);
  }

  function syncStart() {
    if (!start) return;
    start.hidden = !canFullScreen() || !!document.fullscreenElement || storeGet('mirror-windowed') === '1';
  }

  if (start) {
    start.addEventListener('click', function (event) {
      var button = event.target.closest('button');
      if (!button) return;
      if (button.dataset.start === 'windowed') storeSet('mirror-windowed', '1');
      else {
        storeSet('mirror-windowed', '');
        goFullScreen();
      }
      start.hidden = true;
    });
    syncStart();
  }

  /* ---- the menu ---- */
  var menuButton = $('mirror-menu');
  var menu = $('mirror-menu-items');

  function closeMenu() {
    menu.hidden = true;
    menuButton.setAttribute('aria-expanded', 'false');
  }

  menuButton.addEventListener('click', function () {
    menu.hidden = !menu.hidden;
    menuButton.setAttribute('aria-expanded', String(!menu.hidden));
  });

  menu.addEventListener('click', function (event) {
    var tool = event.target.closest('[data-tool]');
    if (!tool) return;
    closeMenu();
    if (tool.dataset.tool === 'rotate') {
      rotation = (rotation + 90) % 360;
      storeSet('mirror-rotation', String(rotation));
      layout();
    } else if (tool.dataset.tool === 'fullscreen') {
      if (document.fullscreenElement) {
        storeSet('mirror-windowed', '1');
        document.exitFullscreen();
      } else {
        storeSet('mirror-windowed', '');
        goFullScreen();
      }
    } else if (tool.dataset.tool === 'keyboard') {
      $('mirror-keys').hidden = false;
      $('mirror-text').focus();
    }
  });

  /* ---- typing ---- */
  $('mirror-keys').addEventListener('submit', function (event) {
    event.preventDefault();
    var input = $('mirror-text');
    if (input.value) send({ type: 'text', text: input.value });
    input.value = '';
  });

  $('mirror-keys').addEventListener('click', function (event) {
    var button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-close-keys')) {
      $('mirror-text').blur();
      $('mirror-keys').hidden = true;
    } else if (button.dataset.key) {
      send({ type: 'key', key: button.dataset.key });
    }
  });

  if (!key) {
    showStatus('Scan the screen remote code on the table to open this page.');
  } else {
    nextFrame();
  }
})();
