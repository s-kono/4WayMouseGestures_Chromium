// 右ボタンの状態を 1 か所で管理し、
//   ・右ボタンドラッグ → 4方向ジェスチャ（赤線で軌跡を描画）
//   ・右ボタン押下中ホイール → アクティブタブ切り替え
// を振り分ける。どちらかが成立したら、その後の contextmenu を抑止する。
//
// ※ Windows の Chromium では contextmenu は mouseup 後に発火する前提。
(() => {
  // ---- ジェスチャ判定パラメータ（0.1 と同じ） ----
  const MOVE_THRESHOLD = 12;
  const MIN_GESTURE_LENGTH = 40;
  const AXIS_RATIO = 1.8;
  const MIN_BOTH_AXIS = 40;
  const TURN_ANGLE_THRESHOLD = 60;
  const MAX_TURN_ANGLE = 120;

  // ---- ホイール判定パラメータ ----
  const WHEEL_THROTTLE_MS = 120;

  const SUPPRESS_TIMEOUT_MS = 500;

  // ---- 状態 ----
  let rightHeld = false;        // このフレームで右ボタン押下中
  let capturing = false;        // ジェスチャ軌跡を記録中
  let movedEnough = false;
  let wheelUsed = false;        // 今回の右ボタン押下中にホイールでタブ切り替えした
  let carried = false;          // 他タブから右ボタン押下状態のまま遷移してきた
  let points = [];
  let start = null;
  let lastWheelTime = 0;

  let suppressContextMenu = false;
  let suppressClearTimer = null;

  // ---- 設定 ----
  // 既定: ホイール下で次のタブ、上で前のタブ。reverseScroll=true で逆転
  let reverseScroll = false;
  try {
    chrome.storage.local.get('reverseScroll', (r) => {
      reverseScroll = r?.reverseScroll === true;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.reverseScroll) {
        reverseScroll = changes.reverseScroll.newValue === true;
      }
    });
  } catch (e) {}

  // ---- 軌跡描画 ----
  let canvas = null;
  let ctx = null;

  function createCanvas() {
    if (canvas || !document.documentElement) return;
    canvas = document.createElement('canvas');
    Object.assign(canvas.style, {
      position: 'fixed', left: '0', top: '0',
      width: window.innerWidth + 'px', height: window.innerHeight + 'px',
      zIndex: '2147483647', pointerEvents: 'none'
    });
    canvas.width = window.innerWidth * devicePixelRatio;
    canvas.height = window.innerHeight * devicePixelRatio;
    document.documentElement.appendChild(canvas);
    ctx = canvas.getContext('2d');
    ctx.scale(devicePixelRatio, devicePixelRatio);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
  }

  function resizeCanvas() {
    if (!canvas) return;
    canvas.width = window.innerWidth * devicePixelRatio;
    canvas.height = window.innerHeight * devicePixelRatio;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.scale(devicePixelRatio, devicePixelRatio);
  }

  function removeCanvas() {
    if (!canvas) return;
    try { canvas.remove(); } catch (e) {}
    canvas = null;
    ctx = null;
  }

  function draw() {
    if (!ctx || points.length < 2) return;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.strokeStyle = '#ff0000';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
  }

  // ---- ジェスチャ判定 ----
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
      if (pts[i].x !== pts[i + 1].x || pts[i].y !== pts[i + 1].y) break;
      i++;
    }
    if (i >= pts.length - 1) return 0;
    let prevAngle = angleBetween(pts[i], pts[i + 1]);
    for (let j = i + 1; j < pts.length - 1; j++) {
      const p = pts[j], q = pts[j + 1];
      if (p.x === q.x && p.y === q.y) continue;
      const ang = angleBetween(p, q);
      const absDelta = Math.abs(normalizeAngleDiff(ang - prevAngle));
      if (absDelta >= TURN_ANGLE_THRESHOLD && absDelta <= MAX_TURN_ANGLE) count++;
      prevAngle = ang;
    }
    return count;
  }

  function detectGesture() {
    const last = points[points.length - 1] || start;
    const dx = last.x - start.x;
    const dy = last.y - start.y;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    if (Math.max(absDx, absDy) < MIN_GESTURE_LENGTH) return null;

    const horizontalDominant = absDx >= AXIS_RATIO * absDy && absDx >= MIN_GESTURE_LENGTH;
    const verticalDominant = absDy >= AXIS_RATIO * absDx && absDy >= MIN_GESTURE_LENGTH;

    if (absDx >= MIN_BOTH_AXIS && absDy >= MIN_BOTH_AXIS && countLargeTurns(points) >= 1) return null;
    if (!horizontalDominant && !verticalDominant) return null;

    if (horizontalDominant) return dx > 0 ? 'right' : 'left';
    return dy > 0 ? 'down' : 'up';
  }

  // ---- contextmenu 抑止 ----
  function armSuppress() {
    suppressContextMenu = true;
    if (suppressClearTimer) clearTimeout(suppressClearTimer);
    suppressClearTimer = setTimeout(() => {
      suppressContextMenu = false;
      suppressClearTimer = null;
    }, SUPPRESS_TIMEOUT_MS);
  }

  function clearSuppress() {
    suppressContextMenu = false;
    if (suppressClearTimer) {
      clearTimeout(suppressClearTimer);
      suppressClearTimer = null;
    }
  }

  function send(msg) {
    try {
      if (chrome?.runtime?.sendMessage) chrome.runtime.sendMessage(msg).catch?.(() => {});
    } catch (e) {}
  }

  // ---- ジェスチャの開始／終了 ----
  function stopCapture() {
    capturing = false;
    movedEnough = false;
    points = [];
    removeCanvas();
  }

  function onMouseMove(e) {
    if (!capturing) return;
    const p = { x: e.clientX, y: e.clientY };
    points.push(p);
    if (!movedEnough && Math.hypot(p.x - start.x, p.y - start.y) > MOVE_THRESHOLD) movedEnough = true;
    draw();
  }

  // ---- イベント登録（すべて capture フェーズ。ページ側の stopPropagation の影響を受けない） ----
  window.addEventListener('mousedown', (e) => {
    // 新しい押下が来た = 前の押下はどこかで離されている。持ち越し状態を破棄
    carried = false;
    if (e.button !== 2) return;
    rightHeld = true;
    wheelUsed = false;
    start = { x: e.clientX, y: e.clientY };
    points = [start];
    capturing = true;
    movedEnough = false;
    createCanvas();
  }, true);

  window.addEventListener('mousemove', onMouseMove, true);

  window.addEventListener('mouseup', (e) => {
    if (e.button !== 2) return;
    rightHeld = false;

    let gesture = null;
    if (capturing && !wheelUsed) gesture = detectGesture();
    const wasCapturing = capturing;
    stopCapture();

    if (gesture) {
      armSuppress();
      send({ type: 'gesture', gesture });
    } else if (wheelUsed || carried) {
      // ホイールでタブ切り替えした／他タブから押下状態で来た → メニューは出さない
      armSuppress();
    } else if (wasCapturing && movedEnough) {
      armSuppress();
    }
    wheelUsed = false;
    carried = false;
  }, true);

  window.addEventListener('wheel', (e) => {
    // 他タブから遷移してきた直後は mousedown を受けていないので e.buttons で判定する
    const held = rightHeld || (e.buttons & 2) !== 0;
    if (!held) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (Math.abs(e.deltaY) < 1) return;

    // ホイールを使ったらジェスチャは不成立にする
    if (capturing) stopCapture();
    wheelUsed = true;
    e.preventDefault();
    e.stopPropagation();

    const now = Date.now();
    if (now - lastWheelTime < WHEEL_THROTTLE_MS) return;
    lastWheelTime = now;

    let direction = e.deltaY > 0 ? 1 : -1; // 下で次、上で前
    if (reverseScroll) direction *= -1;
    send({ type: 'switch-active-tab', direction });
  }, { capture: true, passive: false });

  window.addEventListener('contextmenu', (e) => {
    if (suppressContextMenu || (capturing && movedEnough) || wheelUsed) {
      e.preventDefault();
      e.stopPropagation();
      clearSuppress();
    }
  }, true);

  window.addEventListener('blur', () => {
    // タブ切り替えやウィンドウ切り替えで mouseup が届かなくなるので状態を戻す
    rightHeld = false;
    wheelUsed = false;
    stopCapture();
  });

  window.addEventListener('resize', () => { if (canvas) resizeCanvas(); });

  // background からの通知：右ボタン押下状態のままこのタブがアクティブになった
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'right-button-carried' && window === window.top) {
        carried = true;
      }
    });
  } catch (e) {}
})();
