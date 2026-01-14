// 右ボタンドラッグで単発上下左右ジェスチャを検出し、赤線で軌跡を描画して background に送る
// 斜めすぎ／L字的なキャンセル動作は不一致（無効）にする
// ジェスチャーが認識された場合は直後の contextmenu 表示を抑止する
(() => {
  const MOVE_THRESHOLD = 12;
  const MIN_GESTURE_LENGTH = 40;
  const AXIS_RATIO = 1.8;
  const MIN_BOTH_AXIS = 40;
  const TURN_ANGLE_THRESHOLD = 60;
  const MAX_TURN_ANGLE = 120;

  let canvas = null;
  let ctx = null;
  let points = [];
  let start = null;
  let capturing = false;
  let movedEnough = false;

  // 新規: ジェスチャーが認識された直後に contextmenu を抑止するためのフラグ
  let suppressContextMenu = false;
  let suppressClearTimer = null;
  const SUPPRESS_TIMEOUT_MS = 500; // 抑止フラグの自動クリア時間

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
    canvas.width = Math.max(document.documentElement.clientWidth, window.innerWidth || 0) * devicePixelRatio;
    canvas.height = Math.max(document.documentElement.clientHeight, window.innerHeight || 0) * devicePixelRatio;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
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
    ctx.scale(devicePixelRatio, devicePixelRatio);
  }

  window.addEventListener('resize', () => {
    if (canvas) resizeCanvas();
  });

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

  function onMouseMove(e) {
    if (!capturing) return;
    const p = { x: e.clientX, y: e.clientY };
    points.push(p);
    if (!movedEnough) {
      const dx = p.x - start.x;
      const dy = p.y - start.y;
      if (Math.hypot(dx, dy) > MOVE_THRESHOLD) movedEnough = true;
    }
    draw();
  }

  function clearSuppressFlag() {
    suppressContextMenu = false;
    if (suppressClearTimer) {
      clearTimeout(suppressClearTimer);
      suppressClearTimer = null;
    }
  }

  function scheduleClearSuppress() {
    if (suppressClearTimer) clearTimeout(suppressClearTimer);
    suppressClearTimer = setTimeout(() => {
      suppressContextMenu = false;
      suppressClearTimer = null;
    }, SUPPRESS_TIMEOUT_MS);
  }

  function onMouseUp(e) {
    if (!capturing) return;
    capturing = false;
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('mouseup', onMouseUp, true);

    const last = points[points.length - 1] || start;
    const dx = last.x - start.x;
    const dy = last.y - start.y;

    removeCanvas();

    if (Math.max(Math.abs(dx), Math.abs(dy)) < MIN_GESTURE_LENGTH) {
      movedEnough = false;
      return;
    }

    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    const horizontalDominant = absDx >= AXIS_RATIO * absDy && absDx >= MIN_GESTURE_LENGTH;
    const verticalDominant = absDy >= AXIS_RATIO * absDx && absDy >= MIN_GESTURE_LENGTH;

    let turned = false;
    if (absDx >= MIN_BOTH_AXIS && absDy >= MIN_BOTH_AXIS) {
      const largeTurns = countLargeTurns(points);
      if (largeTurns >= 1) turned = true;
    }

    if (turned || (!horizontalDominant && !verticalDominant)) {
      movedEnough = false;
      return;
    }

    let dir;
    if (horizontalDominant) {
      dir = dx > 0 ? 'right' : 'left';
    } else {
      dir = dy > 0 ? 'down' : 'up';
    }

    // ジェスチャーが認識されたので、次の contextmenu を抑止する
    // （消費型フラグ：contextmenu を一度抑止したらクリア。万が一 contextmenu が来なければタイムアウトでクリア）
    suppressContextMenu = true;
    scheduleClearSuppress();

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ gesture: dir });
    }

    // movedEnough はここで false に戻す（contextmenu 判定は suppressContextMenu を頼る）
    movedEnough = false;
  }

  // 右ボタン押下でキャプチャ開始
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 2) return;
    start = { x: e.clientX, y: e.clientY };
    points = [start];
    capturing = true;
    movedEnough = false;
    createCanvas();
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('mouseup', onMouseUp, true);
  }, true);

  // contextmenu の抑止：ジェスチャー認識時のみ（かつドラッグ中の簡易抑止も残す）
  document.addEventListener('contextmenu', (e) => {
    // movedEnough はドラッグ中に即座に抑止したいケースのために残すが、
    // ジェスチャー確定後の抑止は suppressContextMenu が主役
    if (suppressContextMenu || movedEnough) {
      e.preventDefault();
      // 消費してすぐクリア（多重抑止を避ける）
      clearSuppressFlag();
    }
  }, true);

  window.addEventListener('blur', () => {
    if (capturing) {
      capturing = false;
      document.removeEventListener('mousemove', onMouseMove, true);
      document.removeEventListener('mouseup', onMouseUp, true);
      removeCanvas();
      movedEnough = false;
    }
  });
})();

