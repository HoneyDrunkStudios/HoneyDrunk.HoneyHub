import { useEffect, useRef } from "react";

/**
 * A deliberately SPARSE, smooth "code rain" backdrop: slow columns of code/hex glyphs
 * gliding down in the honey + neon palette. Two things keep it ambient rather than busy:
 * the motion is continuous (sub-pixel glide, not a grid step), and brightness follows a
 * vertical FLOW across the screen: dim as glyphs enter at the top, brightest through the
 * middle, fading a little toward the bottom. Full-viewport, fixed, pointer-events:none,
 * behind all content. Honors prefers-reduced-motion (static scatter) and pauses when the
 * tab is hidden. The four dials below tune the feel.
 */

// The glyph vocabulary: a wide "code / cyberpunk / honey" mix.
const GLYPHS = (
  "0123456789ABCDEF" +
  "010110100110" +
  "</>{}[]()=;:+-*/~^%$#@!?&|.,_\\" +
  "λΣΔπΩΦΨΘΞΛμσφ∑∆∞≠≈≤≥√∂∫∇⊕⊗" +
  "→←↑↓↻⟶⇌⌁⚙" +
  "⬡⬢⬣⎔⏣" +
  "ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾃﾏｹﾒｴｶｷﾑﾕﾗｾﾈｽﾀﾇﾌｦｲｳ"
).split("");

// --- The four dials ---
const ACTIVE_FRACTION = 0.45; // fraction of columns carrying a stream at once (sparser = calmer)
const GLOBAL_ALPHA = 0.5; // canvas-wide opacity cap; the whole layer stays faint
const FALL_PX_PER_SEC = 100; // continuous fall speed (~150ms to cross one 15px cell, but smooth)
const GLYPH_MUTATE_MS = 380; // how often a stream's inner glyphs re-roll (higher = calmer)

const COLUMN_GAP = 34; // px between columns (wider = sparser)
const TRAIL = 7; // glyphs in a stream's tail
const FONT_PX = 15;
const RESPAWN_MIN_MS = 1200;
const RESPAWN_MAX_MS = 6000;

// A tiny seeded PRNG (mulberry32). The rain is purely decorative, so it needs cheap noise,
// not cryptographic randomness; a seeded generator keeps it out of the security-sensitive
// `Math.random` path while looking just as lively. Seeded once per load for variety.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32((typeof Date === "undefined" ? 1 : Date.now()) || 0x9e3779b9);

interface Stream {
  headPx: number; // continuous pixel position of the leading glyph
  cell: number; // last integer cell the head has crossed (drives glyph shift-in)
  chars: number[]; // glyph indices, [0] = head, growing up the tail
  nextMutate: number;
  color: string;
  active: boolean;
  respawnAt: number;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)] as T;
}
function randGlyph(): number {
  return Math.floor(rng() * GLYPHS.length);
}

/** The vertical flow: dim at the top, brightest ~45% down, fading a little toward the bottom. */
function envelope(yNorm: number): number {
  const peak = 0.45;
  if (yNorm <= peak) {
    return 0.22 + (1 - 0.22) * (yNorm / peak);
  }
  return 1 - (1 - 0.62) * ((yNorm - peak) / (1 - peak));
}

function readPalette(): string[] {
  const root = typeof document === "undefined" ? undefined : document.documentElement;
  const cs = root ? getComputedStyle(root) : undefined;
  const v = (name: string, fallback: string): string => {
    const raw = cs?.getPropertyValue(name).trim();
    return raw && raw.length > 0 ? raw : fallback;
  };
  return [
    v("--honey", "#f4b731"),
    v("--honey-bright", "#ffcf4d"),
    v("--neon-blue", "#4dd6ff"),
    v("--violet", "#9d7bff")
  ];
}

export function MatrixRain(): null {
  const canvasRef = useRef<HTMLCanvasElement | undefined>(undefined);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.className = "matrix-rain";
    canvas.setAttribute("aria-hidden", "true");
    document.body.appendChild(canvas);
    canvasRef.current = canvas;
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      canvas.remove();
      return;
    }

    const reduce =
      typeof globalThis.matchMedia === "function" &&
      globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let palette = readPalette();
    let headColor = palette[1] ?? "#ffcf4d";
    let width = 0;
    let height = 0;
    let columns = 0;
    let streams: Stream[] = [];

    const makeStream = (initial: boolean): Stream => {
      const startPx = initial ? -rng() * height : -FONT_PX * TRAIL;
      return {
        headPx: startPx,
        cell: Math.floor(startPx / FONT_PX),
        chars: Array.from({ length: TRAIL + 1 }, randGlyph),
        nextMutate: 0,
        color: pick(palette),
        active: rng() < ACTIVE_FRACTION,
        respawnAt: 0
      };
    };

    const resize = (): void => {
      const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
      width = globalThis.innerWidth;
      height = globalThis.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = `${FONT_PX}px var(--font-mono, monospace)`;
      ctx.textBaseline = "top";
      columns = Math.max(1, Math.floor(width / COLUMN_GAP));
      streams = Array.from({ length: columns }, () => makeStream(true));
    };

    const drawGlyph = (glyph: number, x: number, y: number, alpha: number, color: string): void => {
      if (y < -FONT_PX || y > height + FONT_PX) {
        return;
      }
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      ctx.fillStyle = color;
      ctx.fillText(GLYPHS[glyph] as string, x, y);
    };

    const drawStatic = (): void => {
      ctx.clearRect(0, 0, width, height);
      for (let c = 0; c < columns; c += 1) {
        if (rng() > ACTIVE_FRACTION) {
          continue;
        }
        const x = c * COLUMN_GAP + 4;
        const count = 2 + Math.floor(rng() * 4);
        for (let i = 0; i < count; i += 1) {
          const y = rng() * height;
          drawGlyph(randGlyph(), x, y, GLOBAL_ALPHA * envelope(y / height) * 0.7, pick(palette));
        }
      }
      ctx.globalAlpha = 1;
    };

    // Restart a spent column after a randomized idle gap.
    const respawnStream = (index: number, now: number): void => {
      const s = streams[index];
      if (s === undefined) {
        return;
      }
      if (s.respawnAt === 0) {
        s.respawnAt = now + RESPAWN_MIN_MS + rng() * (RESPAWN_MAX_MS - RESPAWN_MIN_MS);
      } else if (now >= s.respawnAt) {
        streams[index] = { ...makeStream(false), active: true };
      }
    };

    // Glide a stream, shifting a fresh glyph in per crossed cell + a slow inner shimmer.
    // Returns false (and deactivates) once its tail clears the bottom.
    const advanceStream = (s: Stream, now: number, dt: number): boolean => {
      s.headPx += (FALL_PX_PER_SEC * dt) / 1000;
      const cellNow = Math.floor(s.headPx / FONT_PX);
      for (let k = s.cell; k < cellNow; k += 1) {
        s.chars.unshift(randGlyph());
        s.chars.pop();
      }
      s.cell = cellNow;
      if (now >= s.nextMutate) {
        s.chars[1 + Math.floor(rng() * TRAIL)] = randGlyph();
        s.nextMutate = now + GLYPH_MUTATE_MS * (0.6 + rng() * 0.8);
      }
      if (s.headPx - TRAIL * FONT_PX > height) {
        s.active = false;
        s.respawnAt = 0;
        return false;
      }
      return true;
    };

    // Draw head + tail; brightness is the screen-position envelope, with a light tail fade and
    // a brighter honey head so it still reads as a leading glyph.
    const drawStream = (s: Stream, x: number): void => {
      for (let t = 0; t <= TRAIL; t += 1) {
        const y = s.headPx - t * FONT_PX;
        const tail = t === 0 ? 1 : 1 - 0.5 * (t / TRAIL);
        drawGlyph(s.chars[t] ?? 0, x, y, GLOBAL_ALPHA * envelope(y / height) * tail, t === 0 ? headColor : s.color);
      }
    };

    let raf = 0;
    let last = 0;

    const frame = (now: number): void => {
      const dt = last === 0 ? 16 : Math.min(now - last, 50); // cap so a tab-refocus never jumps
      last = now;
      ctx.clearRect(0, 0, width, height);
      for (let c = 0; c < columns; c += 1) {
        const s = streams[c];
        if (s === undefined) {
          continue;
        }
        if (!s.active) {
          respawnStream(c, now);
        } else if (advanceStream(s, now, dt)) {
          drawStream(s, c * COLUMN_GAP + 4);
        }
      }
      ctx.globalAlpha = 1;
      raf = globalThis.requestAnimationFrame(frame);
    };

    const start = (): void => {
      if (raf === 0) {
        last = 0;
        raf = globalThis.requestAnimationFrame(frame);
      }
    };
    const stop = (): void => {
      if (raf !== 0) {
        globalThis.cancelAnimationFrame(raf);
        raf = 0;
      }
    };
    const onVisibility = (): void => {
      if (document.hidden) {
        stop();
      } else if (!reduce) {
        start();
      }
    };
    const onThemeChange = (): void => {
      palette = readPalette();
      headColor = palette[1] ?? headColor;
    };

    resize();
    globalThis.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibility);
    const observer = new MutationObserver(onThemeChange);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class"]
    });

    if (reduce) {
      drawStatic();
    } else {
      start();
    }

    return () => {
      stop();
      globalThis.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
      observer.disconnect();
      canvas.remove();
      canvasRef.current = undefined;
    };
  }, []);

  return null;
}
