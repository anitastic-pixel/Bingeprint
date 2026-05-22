// shape-canvas-painters.js
//
// Per-family canvas painters for the Shape surface BG motif. Replaces
// the SVG-based buildPanelBgMotif system: each family has a hand-
// authored canvas painter that draws ambient texture (sakura petals,
// god-rays, ink slashes, etc.) frame-by-frame at requestAnimationFrame
// cadence.
//
// The painter functions are ported verbatim from the design handoff
// (CR Smart Scoring-handoff/cr-smart-scoring/project/uploads/Crunchyroll
// Smart Scoring_legit/Sidepanel.html) — visual tuning lives in those
// magic numbers and we don't second-guess them.
//
// Public surface:
//   mountShapeCanvas(container, family, opts) → handle
//     - container: the element to host the canvas (e.g. .shape-panel-motif)
//     - family: 'drama' | 'mystery' | 'romance' | 'comfort' | 'spectacle'
//               | 'comedy' | 'auteur' | 'mixed' | (anything else → mixed)
//     - opts: { onSizeAnchor?: Element }  // resize-observer target
//   handle.setFamily(family)  // hot-swap painter; resets t0 + nonce
//   handle.destroy()          // cancel RAF, disconnect observer, remove canvas
//
// Caller (sidepanel.js) is responsible for the gate: mount only when
// tasteShapeAnimateBg is true AND prefers-reduced-motion is not set.
// A reduced-motion / animate-off state means "no canvas in the DOM at
// all" — not a frozen frame.
//
// Tempo: callers set window.__animTempo to 'swift' | 'balanced' |
// 'leisurely' | 'off' to tune per-painter durations. The auteur painter
// reads it directly per frame to scale its slot stagger + cycle length.

const FAMILY_MAP = {
  drama: 'drama',
  mystery: 'mystery',
  romance: 'romance',
  comfort: 'comfort',
  spectacle: 'spectacle',
  comedy: 'comedy',
  auteur: 'auteur',
  mixed: 'mixed',
};

function resolveFamily(family) {
  return FAMILY_MAP[family] || 'mixed';
}

// Per-family particle factories. Returned arrays are mutated in place
// by the painters across frames (positions, life cycles, trails). Re-
// initialised on family change or canvas resize.
function initParticles(family, W, H) {
  switch (family) {
    case 'drama':
      return Array.from({ length: 22 }, () => ({
        x: Math.random() * W, y: Math.random() * H,
        r: 2.5 + Math.random() * 2.5, vy: 0.4 + Math.random() * 0.5,
        windX: (Math.random() - 0.5) * 0.3,
        phase: Math.random() * Math.PI * 2,
        rot: Math.random() * Math.PI * 2, rotSpeed: (Math.random() - 0.5) * 0.025,
      }));
    case 'romance':
      return Array.from({ length: 26 }, () => ({
        x: Math.random() * W, y: Math.random() * H,
        r: 1.5 + Math.random() * 2.5, vy: 0.25 + Math.random() * 0.4,
        phase: Math.random() * Math.PI * 2, life: Math.random(),
      }));
    case 'comfort':
      return Array.from({ length: 28 }, (_, i) => ({
        x: Math.random() * W, y: Math.random() * H,
        r: 1.2 + Math.random() * 2, vy: 0.18 + Math.random() * 0.3,
        phase: Math.random() * Math.PI * 2, isSteam: i < 6, steamAge: Math.random(),
      }));
    case 'spectacle':
      return Array.from({ length: 35 }, () => {
        const a = Math.random() * Math.PI * 2, d = Math.random() * 30;
        return {
          x: W * 0.5 + Math.cos(a) * d, y: H * 0.32 + Math.sin(a) * d,
          vx: Math.cos(a) * (1 + Math.random() * 2.5), vy: Math.sin(a) * (1 + Math.random() * 2.5),
          r: 0.8 + Math.random() * 1.4, life: Math.random(), phase: Math.random() * Math.PI * 2,
        };
      });
    case 'auteur':
      return Array.from({ length: 20 }, () => ({
        x: Math.random() * W, y: Math.random() * H,
        r: 1.5 + Math.random() * 3.5, phase: Math.random(), vx: 0, vy: 0,
      }));
    case 'comedy':
      return Array.from({ length: 18 }, () => {
        const roll = Math.random();
        let kind;
        if (roll < 0.20) kind = 'haha';
        else if (roll < 0.40) kind = 'sweat';
        else kind = 'glyph';
        return {
          x: 20 + Math.random() * (W - 40), y: 30 + Math.random() * (H - 60),
          r: 2 + Math.random() * 3, phase: Math.random(), curScale: 0,
          kind,
          hahaWord: ['HAHA', 'HA!', 'HEH', 'PFFT'][Math.floor(Math.random() * 4)],
          tilt: (Math.random() - 0.5) * 0.5,
        };
      });
    case 'mystery':
      return Array.from({ length: 6 }, () => ({
        x: Math.random() * W, y: H * 0.05 + Math.random() * H * 0.35,
        r: 3 + Math.random() * 5, phase: Math.random() * Math.PI * 2, vx: 0, vy: 0,
      }));
    case 'mixed':
    default:
      return Array.from({ length: 32 }, () => ({
        x: Math.random() * W, y: Math.random() * H,
        r: 0.8 + Math.random() * 1.8, phase: Math.random() * Math.PI * 2, vx: 0, vy: 0,
      }));
  }
}

// Per-family painters. Each takes (ctx, t, particles, W, H) and renders
// one frame. State across frames is carried in the particles array.
const PAINTERS = {
  drama(ctx, t, p, W, H) {
    ctx.clearRect(0, 0, W, H);
    const breath = 0.5 + 0.5 * Math.sin(t * 0.000785);
    // Dawn-over-Kyoto: amber horizon band ~30% from top
    const dawn = ctx.createLinearGradient(0, H * 0.20, 0, H * 0.42);
    dawn.addColorStop(0, 'rgba(255,180,130,0)');
    dawn.addColorStop(0.5, `rgba(255,170,120,${0.10 * breath})`);
    dawn.addColorStop(1, 'rgba(255,150,110,0)');
    ctx.fillStyle = dawn; ctx.fillRect(0, 0, W, H);
    const g = ctx.createRadialGradient(W * .5, H * .15, 0, W * .5, H * .5, H * .85);
    g.addColorStop(0, `rgba(255,160,130,${0.10 * breath})`);
    g.addColorStop(.5, `rgba(200,80,100,${0.05 * breath})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    // Wind gust: every ~6s a stronger lateral push
    const gustPhase = (t * 0.00017) % 1;
    const gustStrength = gustPhase < 0.18 ? Math.sin(gustPhase / 0.18 * Math.PI) * 1.6 : 0;

    for (const pt of p) {
      // Depth-bucket: foreground (big+blurred), mid (sharp), far (tiny)
      if (pt.depth === undefined) {
        pt.depth = (pt.phase * 7.31) % 1;
      }
      const isFg = pt.depth > 0.75;
      const isFar = pt.depth < 0.30;
      const sizeMul = isFg ? 1.7 : (isFar ? 0.5 : 1.0);
      const speedMul = isFg ? 1.3 : (isFar ? 0.6 : 1.0);

      pt.y += pt.vy * speedMul;
      pt.x += Math.sin(t * .00045 + pt.phase) * .9 + pt.windX + gustStrength;
      pt.rot = (pt.rot || 0) + pt.rotSpeed;
      if (pt.y > H + 12) { pt.y = -12; pt.x = Math.random() * W; }
      const alpha = (0.35 + 0.25 * Math.sin(t * .0008 + pt.phase)) * (isFar ? 0.55 : 1);

      ctx.save();
      ctx.translate(pt.x, pt.y);
      ctx.rotate(pt.rot);
      const tilt = Math.sin(t * 0.001 + pt.phase) * 0.45;
      ctx.scale(Math.cos(tilt) * 0.85 + 0.25, 1);
      if (isFg) ctx.filter = 'blur(1.2px)';

      const sz = pt.r * 1.5 * sizeMul;
      const grad = ctx.createRadialGradient(0, -sz * 0.3, 0, 0, 0, sz * 1.7);
      grad.addColorStop(0, `rgba(255,235,242,${alpha})`);
      grad.addColorStop(0.55, `rgba(255,200,220,${alpha * 0.95})`);
      grad.addColorStop(1, `rgba(245,165,195,${alpha * 0.6})`);
      ctx.fillStyle = grad;
      // Sakura petal: rounded body with V-notched tip
      ctx.beginPath();
      ctx.moveTo(0, -sz * 1.35);
      ctx.bezierCurveTo(sz * 0.55, -sz * 1.15, sz * 0.95, -sz * 0.2, sz * 0.45, sz * 0.85);
      ctx.quadraticCurveTo(0, sz * 1.05, -sz * 0.45, sz * 0.85);
      ctx.bezierCurveTo(-sz * 0.95, -sz * 0.2, -sz * 0.55, -sz * 1.15, 0, -sz * 1.35);
      ctx.closePath();
      ctx.fill();
      // V-notch at tip
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.moveTo(0, -sz * 1.35);
      ctx.lineTo(sz * 0.16, -sz * 1.0);
      ctx.lineTo(-sz * 0.16, -sz * 1.0);
      ctx.closePath();
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();
    }
  },

  romance(ctx, t, p, W, H) {
    ctx.clearRect(0, 0, W, H);
    const haze = 1.0;

    // Edge bloom — soft pink haze
    const el = ctx.createRadialGradient(W * .1, H * .3, 0, W * .1, H * .5, W * .6);
    el.addColorStop(0, `rgba(255,140,190,${0.12 * haze})`); el.addColorStop(1, 'rgba(0,0,0,0)');
    const er = ctx.createRadialGradient(W * .9, H * .5, 0, W * .9, H * .5, W * .6);
    er.addColorStop(0, `rgba(255,100,170,${0.10 * haze})`); er.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = el; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = er; ctx.fillRect(0, 0, W, H);

    // Hierarchy: tiny sparkles 70%, medium ✦ 20%, large ○ rings 10%
    for (let i = 0; i < p.length; i++) {
      const pt = p[i];
      const tier = i < p.length * 0.7 ? 'sparkle' : i < p.length * 0.9 ? 'star' : 'ring';
      pt.y -= pt.vy * (tier === 'ring' ? 0.5 : 1);
      pt.x += Math.sin(t * .00055 + pt.phase) * .5;
      if (pt.y < -20) { pt.y = H + 20; pt.x = Math.random() * W; pt.life = 0; }
      pt.life = (pt.life || 0) + 0.008;
      const lifeFade = Math.min(1, pt.life);

      if (tier === 'sparkle') {
        const a = lifeFade * (0.5 + 0.4 * Math.sin(t * .0014 + pt.phase));
        ctx.fillStyle = `rgba(255,225,238,${a * 0.7})`;
        ctx.beginPath(); ctx.arc(pt.x, pt.y, pt.r * 0.55, 0, Math.PI * 2); ctx.fill();
      } else if (tier === 'star') {
        const a = lifeFade * (0.35 + 0.30 * Math.sin(t * .0012 + pt.phase));
        ctx.save(); ctx.globalAlpha = a;
        ctx.fillStyle = `hsl(${330 + pt.phase * 20},85%,78%)`;
        ctx.font = `${pt.r * 3.2}px serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('✦', pt.x, pt.y);
        ctx.restore();
      } else {
        // Heartbeat-expanding ring
        const expandPhase = (pt.life * 0.55 + pt.phase) % 1;
        const ringR = pt.r * (1 + expandPhase * 6);
        const a = lifeFade * (1 - expandPhase) * 0.45;
        ctx.save();
        ctx.strokeStyle = `rgba(255,180,210,${a})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(pt.x, pt.y, ringR, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
    }
  },

  comfort(ctx, t, p, W, H) {
    ctx.clearRect(0, 0, W, H);
    // Base warm afternoon wash
    const sun = ctx.createLinearGradient(W * .6, 0, W, H * .6);
    sun.addColorStop(0, 'rgba(255,200,120,0.10)');
    sun.addColorStop(.5, 'rgba(255,180,80,0.05)');
    sun.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sun; ctx.fillRect(0, 0, W, H);

    // Ghibli sunbeam: warm, soft, blurred ray angled from upper-left
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const beamPulse = 0.85 + 0.15 * Math.sin(t * 0.0004);
    const beamTopY = 14;

    // 3 parallel light shafts
    const drift = Math.sin(t * 0.000045) * W * 0.04;
    const beamDX = 1.0;
    const beamDY = 0.55;
    const SHAFTS = [
      { originX: -W * 0.10 + drift, width: W * 0.32, alpha: 1.00 },
      { originX: W * 0.18 + drift * 0.8, width: W * 0.14, alpha: 0.75 },
      { originX: W * 0.40 + drift * 0.6, width: W * 0.22, alpha: 0.85 },
    ];
    const drawShaft = (sh, alphaMul, blur) => {
      ctx.save();
      if (blur) ctx.filter = `blur(${blur}px)`;
      const length = W * 1.6;
      const endX0 = sh.originX + length * beamDX;
      const endY0 = beamTopY + length * beamDY;
      const grad = ctx.createLinearGradient(sh.originX, beamTopY, endX0, endY0);
      const a = sh.alpha * alphaMul;
      grad.addColorStop(0, `rgba(255,215,150,${a})`);
      grad.addColorStop(0.45, `rgba(255,190,120,${a * 0.55})`);
      grad.addColorStop(1, 'rgba(255,160,80,0)');
      ctx.fillStyle = grad;
      const x0 = sh.originX;
      const x1 = sh.originX + sh.width;
      const x2 = x1 + length * beamDX;
      const x3 = x0 + length * beamDX;
      const y0 = beamTopY;
      const y1 = beamTopY;
      const y2 = beamTopY + length * beamDY;
      const y3 = beamTopY + length * beamDY;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.lineTo(x3, y3);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };
    for (const sh of SHAFTS) {
      drawShaft(sh, 0.10 * beamPulse, 24);
      drawShaft(sh, 0.13 * beamPulse, 12);
      drawShaft(sh, 0.16 * beamPulse, 4);
    }
    ctx.save();
    ctx.filter = 'blur(38px)';
    const bleed = ctx.createLinearGradient(0, beamTopY, W * 0.7, H * 0.6);
    bleed.addColorStop(0, `rgba(255,200,130,${0.07 * beamPulse})`);
    bleed.addColorStop(1, 'rgba(255,170,90,0)');
    ctx.fillStyle = bleed;
    ctx.fillRect(0, beamTopY, W * 0.9, H * 0.8);
    ctx.restore();
    ctx.restore();

    // Floor light pool
    const pool = ctx.createRadialGradient(W * 0.55, H * 0.92, 0, W * 0.55, H * 0.92, W * 0.55);
    pool.addColorStop(0, `rgba(255,210,140,${0.14 * beamPulse})`);
    pool.addColorStop(0.5, `rgba(255,180,100,${0.06 * beamPulse})`);
    pool.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = pool; ctx.fillRect(0, 0, W, H);

    for (const pt of p) {
      pt.y -= pt.vy * .35;
      pt.x += Math.sin(t * .00038 + pt.phase) * .7;
      if (pt.y < -6) { pt.y = H + 6; pt.x = Math.random() * W; }
      if (pt.isSteam) {
        pt.steamAge = (pt.steamAge || 0) + 0.0025;
        if (pt.steamAge > 1) { pt.steamAge = 0; pt.y = H + 6; pt.x = Math.random() * W; }
        const age = pt.steamAge;
        const curlX = Math.sin(t * 0.0005 + pt.phase * 3) * age * 18
          + Math.sin(t * 0.0011 + pt.phase * 7) * age * 8;
        pt.y -= 0.8 + age * 1.2;
        const a = Math.pow(1 - age, 1.4) * 0.16;
        ctx.save();
        ctx.globalAlpha = a;
        ctx.translate(pt.x + curlX, pt.y);
        const r = pt.r * 4 * (1 + age * 1.8);
        const sg = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
        sg.addColorStop(0, 'rgba(255,235,200,1)');
        sg.addColorStop(0.5, 'rgba(255,215,165,0.5)');
        sg.addColorStop(1, 'rgba(255,200,140,0)');
        ctx.fillStyle = sg;
        ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      } else {
        const isFar = (pt.phase * 5.7) % 1 < 0.4;
        const sizeMul = isFar ? 0.6 : (((pt.phase * 3.1) % 1) < 0.3 ? 1.8 : 1.0);
        const alpha = (0.14 + 0.16 * Math.sin(t * .0009 + pt.phase)) * (isFar ? 0.6 : 1);
        ctx.save();
        if (isFar) ctx.filter = 'blur(1px)';
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pt.r * 0.8 * sizeMul, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,210,140,${alpha})`; ctx.fill();
        ctx.restore();
      }
    }
  },

  spectacle(ctx, t, p, W, H) {
    ctx.clearRect(0, 0, W, H);
    const cx = W * 0.5, cy = 320;
    const PROSE_TOP = 549;
    const VIGNETTE_BOTTOM = H, VIGNETTE_TOP = 14, SAFE_R = 165;
    const pulse = 0.5 + 0.5 * Math.sin(t * 0.001047);
    const aura = ctx.createRadialGradient(cx, cy, SAFE_R * 0.6, cx, cy, W * 0.65);
    aura.addColorStop(0, `rgba(255,200,30,${0.10 * pulse})`);
    aura.addColorStop(0.5, `rgba(255,140,0,${0.06 * pulse})`);
    aura.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.beginPath(); ctx.rect(0, VIGNETTE_TOP, W, VIGNETTE_BOTTOM - VIGNETTE_TOP); ctx.clip();
    ctx.fillStyle = aura; ctx.fillRect(0, VIGNETTE_TOP, W, VIGNETTE_BOTTOM - VIGNETTE_TOP);
    ctx.restore();

    // Burst pulse
    const burstT = (t * 0.00033) % 1;
    const burstPhase = burstT < 0.30 ? Math.sin(burstT / 0.30 * Math.PI) : 0;

    // Action-line vignette
    ctx.save();
    ctx.beginPath(); ctx.rect(0, VIGNETTE_TOP, W, VIGNETTE_BOTTOM - VIGNETTE_TOP); ctx.clip();
    ctx.globalCompositeOperation = 'screen';
    const LINE_COUNT = 56;
    for (let i = 0; i < LINE_COUNT; i++) {
      const baseAngle = (Math.PI * 2 * i) / LINE_COUNT;
      const angle = baseAngle + Math.sin(t * 0.0004 + i * 1.3) * 0.025;
      const downness = Math.max(0, Math.cos(angle - Math.PI / 2));
      if (downness > 0.85 && (i % 3 !== 0)) continue;
      const dx = Math.cos(angle), dy = Math.sin(angle);
      const tRight = dx > 0 ? (W - cx) / dx : Infinity;
      const tLeft = dx < 0 ? (-cx) / dx : Infinity;
      const tBottom = dy > 0 ? (VIGNETTE_BOTTOM - cy) / dy : Infinity;
      const tTop = dy < 0 ? (VIGNETTE_TOP - cy) / dy : Infinity;
      const tEdge = Math.min(tRight, tLeft, tBottom, tTop);
      if (!isFinite(tEdge) || tEdge <= SAFE_R) continue;
      const outerX = cx + dx * tEdge;
      const outerY = cy + dy * tEdge;
      const lenFrac = 0.55 + 0.45 * Math.abs(Math.sin(t * 0.0008 + i * 0.7));
      const inwardPull = burstPhase * 0.18;
      const innerR = SAFE_R + (tEdge - SAFE_R) * (1 - lenFrac - inwardPull);
      const innerX = cx + dx * innerR;
      const innerY = cy + dy * innerR;
      const SEG = 6;
      for (let s = 0; s < SEG; s++) {
        const u0 = s / SEG, u1 = (s + 1) / SEG;
        const x0 = outerX + (innerX - outerX) * u0;
        const y0 = outerY + (innerY - outerY) * u0;
        const x1 = outerX + (innerX - outerX) * u1;
        const y1 = outerY + (innerY - outerY) * u1;
        const wMid = 1.0 - (u0 + u1) * 0.5;
        const width = 0.3 + 1.6 * Math.pow(wMid, 1.4);
        const alpha = (0.10 + 0.10 * Math.abs(Math.sin(t * 0.0009 + i * 0.9)) + burstPhase * 0.08) * Math.pow(wMid, 0.6);
        const lg = ctx.createLinearGradient(x0, y0, x1, y1);
        lg.addColorStop(0, `rgba(255,225,90,${alpha * 1.3})`);
        lg.addColorStop(1, `rgba(255,180,0,${alpha * 0.9})`);
        ctx.beginPath();
        ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
        ctx.strokeStyle = lg;
        ctx.lineWidth = width;
        ctx.lineCap = 'round';
        ctx.stroke();
      }
    }
    // Radar rim glow
    const rimAlpha = 0.06 + burstPhase * 0.12;
    ctx.strokeStyle = `rgba(255,200,80,${rimAlpha})`;
    ctx.lineWidth = 1.2 + burstPhase * 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, SAFE_R, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();

    // Sparks emit FROM center
    if (t >= 2000) {
      const introFade = Math.min(1, (t - 2000) / 1200);
      const introEase = introFade * introFade * (3 - 2 * introFade);
      ctx.save();
      ctx.beginPath(); ctx.rect(0, VIGNETTE_TOP, W, VIGNETTE_BOTTOM - VIGNETTE_TOP); ctx.clip();
      for (const pt of p) {
        if (!pt.trail) pt.trail = [];
        pt.trail.unshift({ x: pt.x, y: pt.y });
        if (pt.trail.length > 8) pt.trail.length = 8;
        pt.x += pt.vx * 0.6; pt.y += pt.vy * 0.6;
        pt.life = (pt.life || 1) - 0.014;
        const distFromCenter = Math.hypot(pt.x - cx, pt.y - cy);
        const fadeAtRing = distFromCenter < SAFE_R - 10
          ? 1
          : distFromCenter < SAFE_R + 30
            ? 1 - (distFromCenter - (SAFE_R - 10)) / 40
            : 0;
        if (pt.life <= 0 || fadeAtRing <= 0) {
          const a = Math.random() * Math.PI * 2;
          const spawnAngle = (a > Math.PI * 0.35 && a < Math.PI * 0.65) ? a + Math.PI : a;
          const d = 8 + Math.random() * 18;
          pt.x = cx + Math.cos(spawnAngle) * d;
          pt.y = cy + Math.sin(spawnAngle) * d;
          const speed = 1.2 + Math.random() * 1.6;
          pt.vx = Math.cos(spawnAngle) * speed;
          pt.vy = Math.sin(spawnAngle) * speed;
          pt.life = 0.5 + Math.random() * 0.7;
          pt.trail = [];
          continue;
        }
        for (let ti = 0; ti < pt.trail.length; ti++) {
          const tp = pt.trail[ti];
          const fade = (1 - ti / pt.trail.length) * pt.life * 0.4 * fadeAtRing;
          ctx.beginPath();
          ctx.arc(tp.x, tp.y, pt.r * (1 - ti / pt.trail.length) * 0.7, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255,230,80,${fade * introEase})`;
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pt.r * 0.9, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,250,200,${pt.life * fadeAtRing * introEase})`;
        ctx.fill();
      }
      ctx.restore();
    }
  },

  auteur(ctx, t, p, W, H) {
    ctx.clearRect(0, 0, W, H);
    // Paper-tone wash
    const vg = ctx.createRadialGradient(W * .5, H * .4, 0, W * .5, H * .5, H * .85);
    vg.addColorStop(0, 'rgba(60,30,120,0.12)');
    vg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);

    // Lazy-load baked brush stroke PNGs from extension assets.
    if (!window.__inkSlashImgs) {
      window.__inkSlashImgs = {};
      const SHAPES = ['diagonal', 'curve', 'scurve'];
      const SEEDS = ['a', 'b', 'c'];
      const baseUrl = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
        ? chrome.runtime.getURL('images/inkslash/')
        : 'images/inkslash/';
      for (const sh of SHAPES) for (const sd of SEEDS) {
        const key = sh + '_' + sd;
        const img = new Image();
        img.src = baseUrl + key + '.png';
        window.__inkSlashImgs[key] = img;
      }
    }
    const imgs = window.__inkSlashImgs;

    const SLOT_COUNT = 7;
    const tempo = window.__animTempo;
    const tempoMul = tempo === 'swift' ? 0.55
      : tempo === 'leisurely' ? 1.70
      : 1.0;
    const START_DELAY_MS = 1500 * tempoMul;
    const BASE_CYCLE_MS = 9000 * tempoMul;
    const SLOT_STAGGER = 1200 * tempoMul;
    const SHAPE_KEYS = ['diagonal_a', 'diagonal_b', 'diagonal_c',
                        'curve_a', 'curve_b', 'curve_c',
                        'scurve_a', 'scurve_b', 'scurve_c'];
    const inkRGB = '160,120,255';

    function rand01(slot, cycle, salt) {
      const nonce = window.__auteurNonce || 0;
      let h = (slot * 374761393) ^ (cycle * 668265263) ^ (salt * 2147483647) ^ (nonce * 1597334677);
      h = (h ^ (h >>> 13)) >>> 0;
      h = (h * 1274126177) >>> 0;
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    }

    if (!window.__auteurBuf || window.__auteurBuf.width !== W || window.__auteurBuf.height !== H) {
      const b = document.createElement('canvas');
      b.width = W; b.height = H;
      window.__auteurBuf = b;
    }
    const bufCtx = window.__auteurBuf.getContext('2d');

    for (let si = 0; si < SLOT_COUNT; si++) {
      const cycleMs = BASE_CYCLE_MS * (0.85 + (si * 0.0743 % 1) * 0.30);
      const slotT = t - START_DELAY_MS - si * SLOT_STAGGER;
      if (slotT < 0) continue;
      const cycle = Math.floor(slotT / cycleMs);
      const phase = (slotT % cycleMs) / cycleMs;

      let env, sweepT;
      if (phase < 0.18) { sweepT = phase / 0.18; env = 1; }
      else if (phase < 0.62) { sweepT = 1; env = 1; }
      else { sweepT = 1; env = 1 - (phase - 0.62) / 0.38; }
      sweepT = 1 - Math.pow(1 - sweepT, 2.4);
      if (env < 0.01) continue;

      const keyIdx = Math.floor(rand01(si, cycle, 1) * SHAPE_KEYS.length);
      const key = SHAPE_KEYS[keyIdx];
      const img = imgs[key];
      if (!img || !img.complete || !img.naturalWidth) continue;

      const gridX = si % 3;
      const gridY = Math.floor(si / 3) % 3;
      const baseX = 0.10 + gridX * 0.30;
      const baseY = 0.08 + gridY * 0.30;
      const cxs = (baseX + rand01(si, cycle, 2) * 0.30) * W;
      const cys = (baseY + rand01(si, cycle, 3) * 0.30) * H;
      const rot = (rand01(si, cycle, 4) - 0.5) * Math.PI * 2;
      const wFrac = 0.45 + rand01(si, cycle, 5) * 0.75;
      const fx = rand01(si, cycle, 6) < 0.5 ? 1 : 0;
      const fy = rand01(si, cycle, 7) < 0.5 ? 1 : 0;
      const alphaPeak = 0.15 + rand01(si, cycle, 8) * 0.24;

      const alpha = env * alphaPeak;
      if (alpha < 0.01) continue;

      const targetW = W * wFrac;
      const targetH = targetW * (img.naturalHeight / img.naturalWidth);

      bufCtx.save();
      bufCtx.clearRect(0, 0, W, H);
      bufCtx.globalAlpha = alpha;
      bufCtx.translate(cxs, cys);
      bufCtx.rotate(rot);
      bufCtx.scale(fx ? -1 : 1, fy ? -1 : 1);
      if (sweepT < 1) {
        bufCtx.beginPath();
        bufCtx.rect(-targetW / 2, -targetH, targetW * sweepT, targetH * 2);
        bufCtx.clip();
      }
      bufCtx.drawImage(img, -targetW / 2, -targetH / 2, targetW, targetH);
      bufCtx.globalCompositeOperation = 'source-in';
      bufCtx.globalAlpha = 1;
      bufCtx.fillStyle = `rgba(${inkRGB},1)`;
      bufCtx.fillRect(-W, -H, W * 3, H * 3);
      bufCtx.restore();

      // Depth-of-field: dim strokes (alphaPeak near 0.15) get more blur,
      // bright strokes (near 0.39) stay crisp. Linear 1.25px → 0px.
      const blurNorm = (alphaPeak - 0.15) / 0.24;
      const blurPx = (1 - blurNorm) * 1.25;
      if (blurPx > 0.05) ctx.filter = `blur(${blurPx.toFixed(2)}px)`;
      ctx.drawImage(window.__auteurBuf, 0, 0);
      if (blurPx > 0.05) ctx.filter = 'none';
    }

    // Sparse paper-incident splatter
    for (let pi = 0; pi < p.length; pi += 2) {
      const pt = p[pi];
      const ph = (t * .00006 + pt.phase) % 1;
      let palpha = ph < .4 ? ph / .4 : ph < .65 ? 1 : 1 - (ph - .65) / .35;
      palpha *= 0.18;
      const sizeBucket = (pt.phase * 5.7) % 1;
      const sizeMul = sizeBucket < 0.15 ? 2.0 : sizeBucket < 0.45 ? 0.9 : 0.45;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, pt.r * 1.0 * sizeMul, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${inkRGB},${palpha})`;
      ctx.fill();
    }
  },

  comedy(ctx, t, p, W, H) {
    ctx.clearRect(0, 0, W, H);
    const g = ctx.createRadialGradient(W * .5, H * .4, 0, W * .5, H * .5, H * .75);
    g.addColorStop(0, 'rgba(200,255,50,0.10)');
    g.addColorStop(.6, 'rgba(255,220,0,0.04)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    const MARKS = ['!', '!!', '?!', '★', '♪', '...'];
    for (let pi = 0; pi < p.length; pi++) {
      const pt = p[pi];
      const cycle = ((t * .000333 + pt.phase * 3) % 1);
      let scale;
      if (cycle < 0.08) {
        scale = 1 - (cycle / 0.08) * 0.15;
        scale = scale * (cycle / 0.08);
      } else if (cycle < 0.18) {
        const u = (cycle - 0.08) / 0.10;
        scale = 0.85 + u * 0.5;
      } else if (cycle < 0.32) {
        const u = (cycle - 0.18) / 0.14;
        scale = 1.35 - u * 0.35 + Math.sin(u * Math.PI * 3) * 0.06 * (1 - u);
      } else if (cycle < 0.75) {
        scale = 1 + 0.10 * Math.sin(t * 0.008 + pt.phase * 10);
      } else {
        scale = 1 - (cycle - 0.75) / 0.25;
      }
      pt.curScale = Math.max(0, scale);
      const alpha = Math.min(1, pt.curScale) * 0.48;
      if (alpha < 0.01) continue;

      // Action lines burst behind
      if (cycle > 0.08 && cycle < 0.32) {
        const burstU = (cycle - 0.08) / 0.24;
        const burstAlpha = (1 - burstU) * 0.35;
        const burstLen = 8 + burstU * 22;
        ctx.save();
        ctx.translate(pt.x, pt.y);
        ctx.strokeStyle = `rgba(255,240,120,${burstAlpha})`;
        ctx.lineWidth = 1.0;
        ctx.lineCap = 'round';
        const lineCount = 8;
        for (let li = 0; li < lineCount; li++) {
          const ang = (li / lineCount) * Math.PI * 2 + pt.phase * 1.7;
          const r0 = 6 + burstU * 4;
          const r1 = r0 + burstLen + (li % 2) * 4;
          ctx.beginPath();
          ctx.moveTo(Math.cos(ang) * r0, Math.sin(ang) * r0);
          ctx.lineTo(Math.cos(ang) * r1, Math.sin(ang) * r1);
          ctx.stroke();
        }
        ctx.restore();
      }

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(pt.x, pt.y);
      ctx.rotate((pt.tilt || 0) + Math.sin(t * 0.002 + pt.phase) * 0.15);
      ctx.scale(pt.curScale, pt.curScale);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

      if (pt.kind === 'sweat') {
        const s = 0.85 + pt.r * 0.18;
        ctx.beginPath();
        ctx.moveTo(0, -8 * s);
        ctx.bezierCurveTo(4 * s, -3 * s, 5.5 * s, 3.5 * s, 0, 7 * s);
        ctx.bezierCurveTo(-5.5 * s, 3.5 * s, -4 * s, -3 * s, 0, -8 * s);
        ctx.closePath();
        ctx.fillStyle = `hsl(${70 + pt.phase * 40},100%,68%)`;
        ctx.strokeStyle = `hsla(${70 + pt.phase * 40},80%,32%,0.55)`;
        ctx.lineWidth = 1.1;
        ctx.lineJoin = 'round';
        ctx.fill();
        ctx.stroke();
      } else if (pt.kind === 'haha') {
        const fs = 14 + pt.r * 3.2;
        ctx.font = `900 ${fs}px "Arial Black", "Helvetica Neue", sans-serif`;
        ctx.fillStyle = `hsl(${70 + pt.phase * 40},100%,68%)`;
        ctx.strokeStyle = `hsla(${70 + pt.phase * 40},80%,28%,0.55)`;
        ctx.lineWidth = 1.4;
        ctx.lineJoin = 'round';
        ctx.strokeText(pt.hahaWord, 0, 0);
        ctx.fillText(pt.hahaWord, 0, 0);
      } else {
        ctx.font = `bold ${10 + pt.r * 2.5}px sans-serif`;
        ctx.fillStyle = `hsl(${70 + pt.phase * 40},100%,68%)`;
        ctx.fillText(MARKS[Math.floor(pt.phase * MARKS.length) % MARKS.length], 0, 0);
      }
      ctx.restore();

      // Speed bubbles
      if (pi % 4 === 0 && cycle > 0.32 && cycle < 0.75) {
        const dx = Math.sin(t * 0.001 + pt.phase * 2) * 0.6;
        for (let bi = 1; bi <= 3; bi++) {
          ctx.beginPath();
          ctx.arc(pt.x - dx * bi * 4, pt.y + bi * 2.5, 0.8, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255,230,90,${alpha * 0.4 / bi})`;
          ctx.fill();
        }
      }
    }
  },

  mystery(ctx, t, p, W, H) {
    ctx.clearRect(0, 0, W, H);
    const base = ctx.createRadialGradient(W * .5, H * .6, 0, W * .5, H * .5, H * .95);
    base.addColorStop(0, 'rgba(0,28,38,0.32)');
    base.addColorStop(.6, 'rgba(0,18,28,0.18)');
    base.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = base; ctx.fillRect(0, 0, W, H);
    // Ocean sine waves
    const SHEETS = [
      { speed: .00000022, yPx: 360, thick: .08, alpha: .07, freq: .0085, amp: 14 },
      { speed: .00000032, yPx: 420, thick: .07, alpha: .09, freq: .0095, amp: 12 },
      { speed: .00000045, yPx: 480, thick: .06, alpha: .10, freq: .011, amp: 10 },
      { speed: .00000060, yPx: 540, thick: .05, alpha: .08, freq: .013, amp: 8 },
    ];
    for (const sh of SHEETS) {
      const ox = (t * sh.speed * W * 60) % (W * 1.5);
      const yBase = sh.yPx;
      const thickPx = sh.thick * 700;
      const fadeTop = Math.max(0, Math.min(1, (yBase - 320) / 60));
      const fadeBot = Math.max(0, Math.min(1, (590 - yBase) / 60));
      const sheetFade = Math.min(fadeTop, fadeBot);
      ctx.save(); ctx.translate(-ox, 0);
      const grad = ctx.createLinearGradient(0, yBase - thickPx, 0, yBase + thickPx);
      grad.addColorStop(0, 'rgba(0,170,200,0)');
      grad.addColorStop(.35, `rgba(0,165,195,${sh.alpha * sheetFade})`);
      grad.addColorStop(.5, `rgba(0,150,180,${sh.alpha * .8 * sheetFade})`);
      grad.addColorStop(1, 'rgba(0,80,120,0)');
      ctx.fillStyle = grad; ctx.beginPath(); ctx.moveTo(-W * .2, H);
      for (let x = -W * .2; x <= W * 2.5; x += 10) {
        const y = yBase
          + Math.sin(x * sh.freq + t * sh.speed * W * 12) * sh.amp
          + Math.sin(x * sh.freq * .6 + t * sh.speed * W * 7 + 2) * sh.amp * .45;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W * 2.5, H); ctx.lineTo(-W * .2, H); ctx.closePath(); ctx.fill(); ctx.restore();
    }
    const top = ctx.createLinearGradient(0, 0, 0, H * .35);
    top.addColorStop(0, 'rgba(0,10,20,0.25)'); top.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = top; ctx.fillRect(0, 0, W, H);

    // Caustics zone
    const causticStart = 700;
    const causticEnd = H;
    const causticZone = Math.max(causticEnd - causticStart, 1);
    const atmosStart = 680;
    const atmosZone = causticEnd - atmosStart;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, causticStart - 30, W, causticZone + 30);
    ctx.clip();

    // Underwater depth wash
    const waterWash = ctx.createLinearGradient(0, causticStart, 0, causticEnd);
    waterWash.addColorStop(0, 'rgba(20,80,100,0.0)');
    waterWash.addColorStop(0.15, 'rgba(15,70,95,0.16)');
    waterWash.addColorStop(0.55, 'rgba(8,50,72,0.26)');
    waterWash.addColorStop(1, 'rgba(2,20,32,0.42)');
    ctx.fillStyle = waterWash; ctx.fillRect(0, causticStart, W, causticZone);

    // God rays
    const RAY_COUNT = 9;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.filter = 'blur(6px)';
    for (let r = 0; r < RAY_COUNT; r++) {
      const seed = r * 0.83;
      const lifePhase = (r * 0.4137) % 1;
      const lifeFreq = 0.00012 + (r % 4) * 0.00004;
      const lifeRaw = 0.5 + 0.5 * Math.sin(t * lifeFreq + lifePhase * Math.PI * 2);
      const lifeFade = Math.pow(lifeRaw, 1.6);

      const angle = -0.42 + (r % 3 - 1) * 0.16 + Math.sin(t * 0.00010 + seed) * 0.07;
      const baseX = (((r / RAY_COUNT) * 1.15 - 0.05 + Math.sin(t * 0.00007 + seed * 2.1) * 0.06) % 1) * W;
      const widthTop = 6 + 6 * Math.abs(Math.sin(t * 0.00016 + seed));
      const widthBot = widthTop * (2.4 + 0.6 * Math.sin(t * 0.00008 + seed * 1.3));
      const len = atmosZone * (0.82 + 0.16 * Math.abs(Math.sin(t * 0.00011 + seed * 1.7)));
      const intensity = (0.025 + 0.055 * lifeFade);

      ctx.save();
      ctx.translate(baseX, atmosStart);
      ctx.rotate(angle);

      const makeGrad = (alphaMul) => {
        const g = ctx.createLinearGradient(0, 0, 0, len);
        g.addColorStop(0.00, 'rgba(200,235,250,0)');
        g.addColorStop(0.10, `rgba(200,235,250,${intensity * alphaMul * 0.35})`);
        g.addColorStop(0.22, `rgba(200,235,250,${intensity * alphaMul * 0.85})`);
        g.addColorStop(0.45, `rgba(180,225,245,${intensity * alphaMul * 1.0})`);
        g.addColorStop(0.70, `rgba(150,210,235,${intensity * alphaMul * 0.55})`);
        g.addColorStop(1.00, 'rgba(80,160,200,0)');
        return g;
      };

      ctx.fillStyle = makeGrad(0.55);
      ctx.beginPath();
      ctx.moveTo(-widthTop * 1.1, 0);
      ctx.lineTo(widthTop * 1.1, 0);
      ctx.lineTo(widthBot * 1.1, len);
      ctx.lineTo(-widthBot * 1.1, len);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = makeGrad(0.85);
      ctx.beginPath();
      ctx.moveTo(-widthTop * 0.55, 0);
      ctx.lineTo(widthTop * 0.55, 0);
      ctx.lineTo(widthBot * 0.55, len);
      ctx.lineTo(-widthBot * 0.55, len);
      ctx.closePath();
      ctx.fill();

      const coreGrad = ctx.createLinearGradient(0, 0, 0, len * 0.78);
      coreGrad.addColorStop(0.00, 'rgba(230,248,255,0)');
      coreGrad.addColorStop(0.15, `rgba(230,248,255,${intensity * 0.75})`);
      coreGrad.addColorStop(0.45, `rgba(210,238,250,${intensity * 1.05})`);
      coreGrad.addColorStop(1.00, 'rgba(140,200,225,0)');
      ctx.fillStyle = coreGrad;
      ctx.beginPath();
      ctx.moveTo(-widthTop * 0.18, 0);
      ctx.lineTo(widthTop * 0.18, 0);
      ctx.lineTo(widthBot * 0.18, len * 0.78);
      ctx.lineTo(-widthBot * 0.18, len * 0.78);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.filter = 'none';
    ctx.restore();

    // Suspended motes
    const DUST_COUNT = 110;
    for (let d = 0; d < DUST_COUNT; d++) {
      const seedX = (d * 0.7548776) % 1;
      const seedY = (d * 0.4357683) % 1;
      const phaseA = d * 1.4 + 0.3;
      const phaseB = d * 2.7 + 1.1;
      const phaseC = d * 0.91 + 0.7;

      const wanderX = Math.sin(t * 0.00018 + phaseA) * 12
        + Math.sin(t * 0.00041 + phaseB) * 5
        + Math.cos(t * 0.00009 + phaseC) * 8;
      const wanderY = Math.cos(t * 0.00022 + phaseA) * 10
        + Math.sin(t * 0.00037 + phaseC) * 6;

      const driftSpeed = 0.005 + (d % 9) * 0.003;
      const driftY = (t * driftSpeed) % atmosZone;

      const px = (seedX * W) + wanderX;
      const py = atmosStart + ((seedY * atmosZone - driftY) % atmosZone + atmosZone) % atmosZone + wanderY;

      const fadeFreq = 0.00050 + (d % 5) * 0.00015;
      const fadePhase = d * 0.6;
      const fadeRaw = 0.5 + 0.5 * Math.sin(t * fadeFreq + fadePhase);
      const tw = Math.pow(fadeRaw, 1.8);

      const yProgress = (py - atmosStart) / atmosZone;
      let posFade;
      if (yProgress < 0.18) {
        posFade = Math.max(0, yProgress / 0.18);
        posFade = posFade * posFade;
      } else if (yProgress > 0.92) {
        posFade = Math.max(0, (1 - yProgress) / 0.08);
      } else {
        posFade = 1;
      }

      const r = 0.4 + 1.2 * ((d * 0.31) % 1);
      const depthScale = 1 + (py - atmosStart) / atmosZone * 0.5;
      const finalAlpha = tw * posFade;

      if (finalAlpha > 0.5) {
        ctx.beginPath();
        ctx.arc(px, py, r * depthScale * 2.4, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(220,245,255,${0.06 * finalAlpha})`;
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(px, py, r * depthScale, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(220,245,255,${0.28 * finalAlpha})`;
      ctx.fill();
    }

    // Seafloor caustics
    const floorStart = causticStart + causticZone * 0.55;
    const floorZone = causticEnd - floorStart;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';

    const CELLS = 32;
    const hash = (n) => {
      const s = Math.sin(n * 12.9898) * 43758.5453;
      return s - Math.floor(s);
    };
    for (let ci = 0; ci < CELLS; ci++) {
      const sx = hash(ci + 1.7);
      const sy = hash(ci * 2.3 + 4.1);
      const driftSpeed = 0.000012 + hash(ci * 0.9 + 7.3) * 0.000022;
      const wobX = Math.sin(t * 0.00009 + ci * 1.31 + sx * 6.28) * 0.05;
      const wobY = Math.sin(t * 0.00013 + ci * 0.83 + sy * 6.28) * 18;

      const px = ((sx + t * driftSpeed + wobX) % 1 + 1) % 1 * W;
      const pyBase = floorStart + sy * floorZone;
      const py = pyBase + wobY;

      const depth = Math.max(0, Math.min(1, (py - floorStart) / floorZone));
      const distFade = Math.pow(depth, 1.6);

      const sizeJitter = 0.7 + hash(ci * 3.7 + 11) * 0.7;
      const rx = (22 + 26 * (0.5 + 0.5 * Math.sin(t * 0.00022 + ci * 1.6))) * (0.55 + depth * 0.85) * sizeJitter;
      const ry = (5 + 5 * (0.5 + 0.5 * Math.cos(t * 0.00018 + ci * 2.3))) * (0.6 + depth * 0.7) * sizeJitter;
      const shimmer = 0.5 + 0.5 * Math.sin(t * 0.00045 + ci * 3.1 + sx * 4);
      const alpha = (0.05 + 0.11 * shimmer) * (0.10 + 0.90 * distFade);

      ctx.save();
      ctx.translate(px, py);
      ctx.scale(1, ry / rx);

      const cg = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      cg.addColorStop(0, `rgba(220,250,255,${alpha * 2.4})`);
      cg.addColorStop(0.45, `rgba(140,225,235,${alpha * 1.0})`);
      cg.addColorStop(1, 'rgba(20,120,160,0)');
      ctx.fillStyle = cg;
      ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.fill();
      ctx.restore();

      if (distFade > 0.3) {
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(Math.sin(t * 0.0001 + ci * 0.4) * 0.2);
        ctx.scale(1, ry / rx * 0.6);
        ctx.beginPath();
        ctx.arc(0, 0, rx * 0.72, -1.6, 1.6);
        ctx.strokeStyle = `rgba(230,255,255,${alpha * 1.8 * (0.6 + 0.4 * shimmer)})`;
        ctx.lineWidth = 0.7 + 0.4 * shimmer;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, 0, rx * 0.42, -2.4, -0.6);
        ctx.strokeStyle = `rgba(200,245,250,${alpha * 1.2})`;
        ctx.lineWidth = 0.5;
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.restore();

    const floorShadow = ctx.createLinearGradient(0, causticEnd - 60, 0, causticEnd);
    floorShadow.addColorStop(0, 'rgba(0,0,0,0)');
    floorShadow.addColorStop(1, 'rgba(0,8,18,0.45)');
    ctx.fillStyle = floorShadow;
    ctx.fillRect(0, causticEnd - 60, W, 60);

    ctx.restore();
  },

  mixed(ctx, t, p, W, H) {
    ctx.clearRect(0, 0, W, H);
    // Nebula: 3 colored radial blobs blending behind stars
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const neb1 = ctx.createRadialGradient(W * 0.25, H * 0.30, 0, W * 0.25, H * 0.30, W * 0.55);
    neb1.addColorStop(0, 'rgba(140,90,200,0.13)');
    neb1.addColorStop(0.6, 'rgba(80,50,140,0.05)');
    neb1.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = neb1; ctx.fillRect(0, 0, W, H);
    const neb2 = ctx.createRadialGradient(W * 0.78, H * 0.55, 0, W * 0.78, H * 0.55, W * 0.65);
    neb2.addColorStop(0, 'rgba(60,140,200,0.10)');
    neb2.addColorStop(0.6, 'rgba(40,100,160,0.04)');
    neb2.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = neb2; ctx.fillRect(0, 0, W, H);
    const neb3 = ctx.createRadialGradient(W * 0.50, H * 0.85, 0, W * 0.50, H * 0.85, W * 0.5);
    neb3.addColorStop(0, 'rgba(220,90,140,0.08)');
    neb3.addColorStop(0.6, 'rgba(160,60,100,0.03)');
    neb3.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = neb3; ctx.fillRect(0, 0, W, H);
    ctx.restore();

    const g = ctx.createRadialGradient(W * .5, H * .35, 0, W * .5, H * .45, H * .7);
    g.addColorStop(0, 'rgba(255,140,40,0.06)');
    g.addColorStop(.6, 'rgba(200,80,20,0.02)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    // Shooting star — rare diagonal streak every ~8s
    const ssCycle = (t * 0.000125) % 1;
    if (ssCycle < 0.08) {
      const u = ssCycle / 0.08;
      const cycleIdx = Math.floor(t * 0.000125);
      const startX = ((cycleIdx * 0.61803) % 1) * W * 0.6;
      const startY = H * 0.1 + ((cycleIdx * 0.31415) % 1) * H * 0.3;
      const len = 80;
      const angle = 0.4 + ((cycleIdx * 0.27) % 1) * 0.3;
      const headX = startX + Math.cos(angle) * len * (0.3 + u);
      const headY = startY + Math.sin(angle) * len * (0.3 + u);
      const tailX = headX - Math.cos(angle) * 60;
      const tailY = headY - Math.sin(angle) * 60;
      const fade = u < 0.4 ? u / 0.4 : 1 - (u - 0.4) / 0.6;
      const tg = ctx.createLinearGradient(tailX, tailY, headX, headY);
      tg.addColorStop(0, 'rgba(255,230,200,0)');
      tg.addColorStop(1, `rgba(255,250,230,${fade})`);
      ctx.strokeStyle = tg; ctx.lineWidth = 1.8; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(tailX, tailY); ctx.lineTo(headX, headY); ctx.stroke();
      ctx.beginPath(); ctx.arc(headX, headY, 2.2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,240,${fade})`; ctx.fill();
    }

    // Stars with twinkle
    for (let i = 0; i < p.length; i++) {
      const pt = p[i];
      const tw = 0.3 + 0.7 * Math.abs(Math.sin(t * .0006 + pt.phase * 4));
      const isBright = i % 4 === 0;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, pt.r * .6, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,235,210,${tw * .7})`;
      ctx.fill();
      if (isBright && tw > 0.85) {
        const spike = (tw - 0.85) / 0.15;
        const len = pt.r * 4 * spike;
        const a = spike * 0.4;
        ctx.save();
        ctx.strokeStyle = `rgba(255,245,220,${a})`;
        ctx.lineWidth = 0.8;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(pt.x - len, pt.y); ctx.lineTo(pt.x + len, pt.y);
        ctx.moveTo(pt.x, pt.y - len); ctx.lineTo(pt.x, pt.y + len);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Constellation lines
    for (let i = 0; i < Math.min(p.length, 14); i++) {
      const a = p[i], b = p[(i + 3) % p.length];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d > 180) continue;
      const linePhase = ((t * 0.00015 + i * 0.13) % 1);
      let drawProgress, alpha;
      if (linePhase < 0.15) {
        drawProgress = linePhase / 0.15;
        alpha = drawProgress * 0.18;
      } else if (linePhase < 0.65) {
        drawProgress = 1;
        alpha = 0.12 + 0.08 * Math.sin(t * 0.0004 + i * .8);
      } else {
        drawProgress = 1;
        alpha = (1 - (linePhase - 0.65) / 0.35) * 0.18;
      }
      const ex = a.x + (b.x - a.x) * drawProgress;
      const ey = a.y + (b.y - a.y) * drawProgress;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(ex, ey);
      ctx.strokeStyle = `rgba(255,200,150,${alpha})`;
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }
  },
};

// Mount a canvas inside `container`, paint with the family painter, and
// return a handle for swap/teardown. Callers gate this on
// tasteShapeAnimateBg + prefers-reduced-motion before calling.
export function mountShapeCanvas(container, family, opts = {}) {
  const sizeAnchor = opts.sizeAnchor || container;
  const fam = resolveFamily(family);

  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.position = 'absolute';
  canvas.style.top = '0';
  canvas.style.left = '0';
  canvas.style.width = '100%';
  canvas.style.height = 'auto';
  canvas.style.minHeight = '100%';
  canvas.style.display = 'block';
  canvas.style.pointerEvents = 'none';
  canvas.style.opacity = '0';
  canvas.style.transition = 'opacity 800ms ease';
  container.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  let W = 380, H = 700;
  let particles = [];
  let currentFamily = fam;
  let raf = null;
  let t0 = null;
  let paused = false;
  // Fresh randomization seed for the auteur brush wallpaper.
  window.__auteurNonce = (Math.random() * 1e9) | 0;

  function resizeCanvas() {
    const newW = sizeAnchor.clientWidth || 380;
    // Use scrollHeight so canvas covers all content including axes below the fold
    const newH = Math.max(sizeAnchor.scrollHeight, 900);
    if (canvas.width !== newW || canvas.height !== newH) {
      W = newW; H = newH;
      canvas.width = W; canvas.height = H;
      particles = initParticles(currentFamily, W, H);
    }
  }
  resizeCanvas();
  // Re-measure after a tick (content may not be laid out yet)
  setTimeout(resizeCanvas, 200);
  const ro = new ResizeObserver(() => setTimeout(resizeCanvas, 50));
  ro.observe(sizeAnchor);

  function loop(ts) {
    if (paused) { raf = null; return; }
    if (t0 === null) t0 = ts;
    const t = ts - t0;
    const painter = PAINTERS[currentFamily] || PAINTERS.mixed;
    // Global panel-interior clip. Insets match .surface-shape's
    // padding (18 18 24) so petals/sparks/etc. stay inside the
    // visible content column instead of bleeding into the surface
    // margin between the content edge and the panel boundary —
    // that mismatch was reading as "the glow has weird padding".
    // RADIUS matches .shape-header's border-radius for the rounded
    // top corners of the painted region.
    const INSET_TOP = 18, INSET_SIDE = 18, INSET_BOTTOM = 24;
    const RADIUS = 12;
    ctx.save();
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(INSET_SIDE, INSET_TOP, W - INSET_SIDE * 2, H - INSET_TOP - INSET_BOTTOM, RADIUS);
    } else {
      ctx.rect(INSET_SIDE, INSET_TOP, W - INSET_SIDE * 2, H - INSET_TOP - INSET_BOTTOM);
    }
    ctx.clip();
    painter(ctx, t, particles, W, H);
    ctx.restore();
    raf = requestAnimationFrame(loop);
  }
  // Fade-in
  requestAnimationFrame(() => { canvas.style.opacity = '1'; });
  raf = requestAnimationFrame(loop);

  return {
    setFamily(nextFamily) {
      const next = resolveFamily(nextFamily);
      if (next === currentFamily) return;
      currentFamily = next;
      t0 = null;
      window.__auteurNonce = (Math.random() * 1e9) | 0;
      particles = initParticles(currentFamily, W, H);
    },
    pause() {
      if (paused) return;
      paused = true;
      if (raf) { cancelAnimationFrame(raf); raf = null; }
    },
    resume() {
      if (!paused) return;
      paused = false;
      t0 = null; // restart relative time so painter intros replay cleanly
      raf = requestAnimationFrame(loop);
    },
    // Motion toggle (tasteShapeAnimateBg flips, reduced-motion gains/
    // loses). Previously the caller destroyed + remounted the entire
    // canvas to honor the "no frozen frame" rule from the panel motif
    // design; this paid full DOM creation cost + ResizeObserver re-
    // setup on every toggle. setMotion keeps the canvas mounted and
    // fades/clears it so the visual contract is preserved (motion-off
    // shows no static frame) while making toggles ~free.
    setMotion(on) {
      if (on) {
        if (!paused) return;
        paused = false;
        t0 = null;
        // Fresh particles on resume so the user doesn't see a literal
        // continuation of the prior pre-pause state — mirrors the
        // mount-time behavior the destroy/remount path produced.
        window.__auteurNonce = (Math.random() * 1e9) | 0;
        particles = initParticles(currentFamily, W, H);
        // Re-fade in (matches the initial mount transition).
        canvas.style.opacity = '0';
        requestAnimationFrame(() => { canvas.style.opacity = '1'; });
        raf = requestAnimationFrame(loop);
      } else {
        if (paused) return;
        paused = true;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        // Fade + clear so the paused canvas reads as "no canvas
        // visible" — matches the original destroy/remount visual.
        canvas.style.opacity = '0';
        ctx.clearRect(0, 0, W, H);
      }
    },
    destroy() {
      paused = true;
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      ro.disconnect();
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    },
  };
}
