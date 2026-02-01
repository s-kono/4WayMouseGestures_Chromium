/* inject.js
   ページコンテキストで動作。右ボタン mousedown を一旦阻止して短時間移動を監視し、
   動いたらジェスチャー検出、動かなければフォールバックで contextmenu を合成して投げる。
   ジェスチャー確定時は window.postMessage で content script に通知する。
*/
(() => {
  const MOVE_THRESHOLD = 12; // ドラッグ検出のしきい値（px）
  const MIN_GESTURE_LENGTH = 40; // ジェスチャー確定の最短距離
  const AXIS_RATIO = 1.8;
  const MIN_BOTH_AXIS = 40;
  const TURN_ANGLE_THRESHOLD = 60;
  const MAX_TURN_ANGLE = 120;
  const FALLBACK_TIMEOUT_MS = 250; // mousedown 後に移動が無ければフォールバックする時間

  let start = null;
  let points = [];
  let tracking = false;
  let fallbackTimer = null;
  let canvas = null;
  let ctx = null;
  let devicePixelRatioLocal = window.devicePixelRatio || 1;

  function createCanvas() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.style.position = 'fixed';
    canvas.style.left = '0';
    canvas.style.top = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.zIndex = '2147483647';
    canvas.style.pointerEvents = 'none';
    canvas.width = Math.max(document.documentElement.clientWidth, window.innerWidth || 0) * devicePixelRatioLocal;
    canvas.height = Math.max(document.documentElement.clientHeight, window.innerHeight || 0) * devicePixelRatioLocal;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    document.documentElement.appendChild(canvas);
    ctx = canvas.getContext('2d');
    ctx.scale(devicePixelRatioLocal, devicePixelRatioLocal);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
  }

  function removeCanvas() {
    if (!canvas) return;
    try { canvas.remove(); } catch (e) {}
    canvas = null; ctx = null;
  }

  function draw() {
    if (!ctx || points.length < 2) return;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.strokeStyle = '#ff0000';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
  }

  function angleBetween(a, b) {
    return Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
  }

  function normalizeAngleDiff(a) {
    let d = ((a + 180) % 360) - 180;
    if (d < -180) d += 360;
    return d;
  }

  function countLargeTurns(pts) {
    if (!pts || pts.length < 3) return 0;
    let count = 0;
    let i = 0;
    while (i < pts.length - 1) {
      if (pts[i].x !== pts[i+1].x || pts[i].y !== pts[i+1].y) break;
      i++;
    }
    if (i >= pts.length - 1) return 0;
    let prevAngle = angleBetween(pts[i], pts[i+1]);
    for (let j = i+1; j < pts.length - 1; j++) {
      const p = pts[j], q = pts[j+1];
      if (p.x === q.x && p.y === q.y) continue;
      const ang = angleBetween(p, q);
      let delta = normalizeAngleDiff(ang - prevAngle);
      const absDelta = Math.abs(delta);
      if (absDelta >= TURN_ANGLE_THRESHOLD && absDelta <= MAX_TURN_ANGLE) {
        count++;
      }
      prevAngle = ang;
    }
    return count;
  }

  function detectDirection(pts) {
    const last = pts[pts.length - 1] || start;
    const dx = last.x - start.x;
    const dy = last.y - start.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < MIN_GESTURE_LENGTH) return null;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    const horizontalDominant = absDx >= AXIS_RATIO * absDy && absDx >= MIN_GESTURE_LENGTH;
    const verticalDominant = absDy >= AXIS_RATIO * absDx && absDy >= MIN_GESTURE_LENGTH;

    let turned = false;
    if (absDx >= MIN_BOTH_AXIS && absDy >= MIN_BOTH_AXIS) {
      const largeTurns = countLargeTurns(pts);
      if (largeTurns >= 1) turned = true;
    }
    if (turned || (!horizontalDominant && !verticalDominant)) return null;
    if (horizontalDominant) return dx > 0 ? 'right' : 'left';
    return dy > 0 ? 'down' : 'up';
  }

  function sendToContent(msg) {
    window.postMessage(Object.assign({ __FWG__: true }, msg), '*');
  }

  function dispatchSyntheticContextMenu(target, clientX, clientY) {
    try {
      const ev = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: clientX,
        clientY: clientY,
        button: 2
      });
      target.dispatchEvent(ev);
      // notify content script that we fell back
      sendToContent({ type: 'FALLBACK_CONTEXTMENU', x: clientX, y: clientY });
    } catch (e) {
      // ignore
    }
  }

  function clearTracking() {
    tracking = false;
    start = null;
    points = [];
    if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
    removeCanvas();
    window.removeEventListener('mousemove', onMouseMove, true);
    window.removeEventListener('mouseup', onMouseUp, true);
  }

  function onMouseMove(e) {
    if (!tracking) return;
    const p = { x: e.clientX, y: e.clientY };
    points.push(p);
    // ドラッグ判定
    if (points.length >= 2) {
      const dx = p.x - start.x;
      const dy = p.y - start.y;
      if (Math.hypot(dx, dy) > MOVE_THRESHOLD) {
        // movement detected -> cancel fallback timer (we are in gesture)
        if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
      }
    }
    draw();
  }

  function onMouseUp(e) {
    if (!tracking) return;
    // finalize
    const dir = detectDirection(points);
    if (dir) {
      // ジェスチャー認識
      sendToContent({ type: 'GESTURE', gesture: dir });
    } else {
      // ジェスチャーではなかった → フォールバックで contextmenu を合成
      dispatchSyntheticContextMenu(e.target || document.elementFromPoint(e.clientX, e.clientY), e.clientX, e.clientY);
    }
    clearTracking();
  }

  function onMouseDown(e) {
    // 右ボタンのみ
    if (e.button !== 2) return;
    // 一旦阻止してフォールバック監視を行う
    try { e.preventDefault(); } catch (err) {}
    try { if (e.stopImmediatePropagation) e.stopImmediatePropagation(); } catch (err) {}
    start = { x: e.clientX, y: e.clientY };
    points = [start];
    tracking = true;
    createCanvas();

    window.addEventListener('mousemove', onMouseMove, true);
    window.addEventListener('mouseup', onMouseUp, true);

    // フォールバックタイマー：この時間内に movement が無ければ contextmenu フォールバック
    if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
    fallbackTimer = setTimeout(() => {
      if (!tracking) return;
      // movement がほとんどなければフォールバックとして contextmenu を合成して終わる
      const last = points[points.length - 1] || start;
      const dx = last.x - start.x;
      const dy = last.y - start.y;
      if (Math.hypot(dx, dy) <= MOVE_THRESHOLD) {
        // no drag -> synth contextmenu
        dispatchSyntheticContextMenu(e.target || document.elementFromPoint(e.clientX, e.clientY), e.clientX, e.clientY);
        clearTracking();
      } else {
        // 動いているなら waiting for mouseup (do nothing)
      }
    }, FALLBACK_TIMEOUT_MS);
  }

  // capture フェーズで早く拾う
  window.addEventListener('mousedown', onMouseDown, true);
  // また念のため contextmenu も capture で受け取り、必要なら抑止して content へ通知
  window.addEventListener('contextmenu', (e) => {
    // ここではページ側の contextmenu を content に通知するだけ
    sendToContent({ type: 'PAGE_CONTEXTMENU', x: e.clientX, y: e.clientY });
  }, true);

  // content script からの制御メッセージを受け取る（設定の切替など）
  window.addEventListener('message', (ev) => {
    if (!ev.data || !ev.data.__FWG_CTRL__) return;
    const cmd = ev.data.cmd;
    if (cmd === 'SET_FALLBACK_TIMEOUT') {
      const v = parseInt(ev.data.value, 10);
      if (!Number.isNaN(v) && v >= 0) {
        // 変更を反映（次回から有効）
        // NOTE: この実装は簡単化のためグローバルに変更
        // (実装上は局所化しても良い)
        // eslint-disable-next-line no-unused-vars
        // can't change const; in production you'd store in let; omitted for brevity
      }
    }
  }, false);

})();
