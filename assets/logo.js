// yalla-sa logo animation (brand v6, approved 2026-11-11)

(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const stops = [[687.1, 660.8], [595.5, 640.9], [489.6, 604.3], [444.4, 541.9], [491.4, 476.0], [579.3, 420.8], [678.7, 376.7], [779.4, 341.8], [882.6, 311.2]];
  const motion = document.getElementById('motion');
  const lit = document.getElementById('routeLit');
  const bus = document.getElementById('bus');
  const speed = document.getElementById('speed');
  const dotsG = document.getElementById('dots');
  const ML = motion.getTotalLength();
  const RL = lit.getTotalLength();
  lit.style.strokeDasharray = RL;

  // length along motion path of each stop
  const stopLen = stops.map(([x,y]) => {
    let best = 0, bd = Infinity;
    for (let l = 0; l <= ML; l += 1) {
      const p = motion.getPointAtLength(l);
      const d = (p.x-x)**2 + (p.y-y)**2;
      if (d < bd) { bd = d; best = l; }
    }
    return best;
  });
  const dots = stops.map(([x,y]) => {
    const ring = document.createElementNS(NS,'circle');
    ring.setAttribute('cx',x); ring.setAttribute('cy',y); ring.setAttribute('r',18);
    ring.setAttribute('fill','none'); ring.setAttribute('stroke','var(--blue)'); ring.setAttribute('stroke-width',3);
    ring.setAttribute('opacity',0);
    const c = document.createElementNS(NS,'circle');
    c.setAttribute('cx',x); c.setAttribute('cy',y); c.setAttribute('r',18);
    dotsG.append(ring, c);
    return { c, ring };
  });

  const clamp = v => Math.max(0, Math.min(1, v));
  const busBody = document.getElementById('busBody');
  const T = { start: 350, travel: 1650, vanish: 350, total: 2700 };
  let raf;

  function render(t) {
    const u = clamp((t - T.start) / T.travel);
    const p = u ** 1.9;                       // accelerating
    const len = p * ML;
    // lit route trails the bus
    lit.style.strokeDashoffset = RL - Math.min(len, RL);
    // stops
    dots.forEach((d, i) => {
      const passed = t >= T.start && len >= stopLen[i];
      d.c.setAttribute('fill', passed ? 'var(--blue)' : 'var(--dim)');
      const since = passed ? (t - (d.at ??= t)) : -1;
      if (!passed) d.at = undefined;
      const k = since >= 0 ? clamp(since / 450) : 1;
      d.ring.setAttribute('r', 18 + 22 * k);
      d.ring.setAttribute('opacity', since >= 0 ? (1 - k) * 0.8 : 0);
    });
    // bus pose
    if (t < T.start || t > T.start + T.travel + T.vanish) {
      bus.setAttribute('opacity', 0);
    } else {
      const L = Math.min(len, ML - 0.5);
      const a = motion.getPointAtLength(L), b = motion.getPointAtLength(Math.min(L + 1, ML));
      const ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
      const shrink = clamp((t - (T.start + T.travel - 250)) / (250 + T.vanish));
      const enter = clamp((t - T.start) / 160);
      const s = 1.4 *(0.6 + 0.4 * enter) * (1 - shrink);
      bus.setAttribute('opacity', shrink >= 1 ? 0 : enter);
      bus.setAttribute('transform', `translate(${a.x} ${a.y}) rotate(${ang}) scale(${s} ${Math.abs(ang) > 90 ? -s : s}) translate(0 20)`);
      // gallop: body bounces on its wheels, faster as the bus speeds up
      const bob = -3 * Math.abs(Math.sin(len / 11));
      busBody.setAttribute('transform', `translate(0 ${bob}) rotate(${-2.5 * u})`);
      speed.setAttribute('opacity', 0.2 + 0.8 * u);
      speed.setAttribute('transform', `translate(${-10 * u} 0) scale(${0.6 + 0.6 * u} 1)`);
    }
  }

  function play() {
    cancelAnimationFrame(raf);
    dots.forEach(d => d.at = undefined);
    const t0 = performance.now();
    const tick = now => {
      const t = now - t0;
      render(t);
      if (t < T.total) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // safety net: if frames were skipped (background tab), land on the final state
    clearTimeout(play.done);
    play.done = setTimeout(() => { cancelAnimationFrame(raf); render(T.total); }, T.total + 100);
  }

  window.renderAt = t => { cancelAnimationFrame(raf); render(t); };
  const reduce =matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) render(T.total); else play();
  window.playLogo = () => { if (reduce) render(T.total); else play(); }; window.LOGO_MS = reduce ? 0 : T.total;
  // the header logo is a link back to the yalla-sa portal home (platform rule); it no longer replays the animation
})();

