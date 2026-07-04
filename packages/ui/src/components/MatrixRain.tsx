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
  return arr[Math.floor(Math.random() * arr.length)] as T;
}
function randGlyph(): number {
  return Math.floor(Math.random() * GLYPHS.length);
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
      const startPx = initial ? -Math.random() * height : -FONT_PX * TRAIL;
      return {
        headPx: startPx,
        cell: Math.floor(startPx / FONT_PX),
        chars: Array.from({ length: TRAIL + 1 }, randGlyph),
        nextMutate: 0,
        color: pick(palette),
        active: Math.random() < ACTIVE_FRACTION,
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
        if (Math.random() > ACTIVE_FRACTION) {
          continue;
        }
        const x = c * COLUMN_GAP + 4;
        const count = 2 + Math.floor(Math.random() * 4);
        for (let i = 0; i < count; i += 1) {
          const y = Math.random() * height;
          drawGlyph(randGlyph(), x, y, GLOBAL_ALPHA * envelope(y / height) * 0.7, pick(palette));
        }
      }
      ctx.globalAlpha = 1;
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
        const x = c * COLUMN_GAP + 4;

        if (!s.active) {
          if (s.respawnAt === 0) {
            s.respawnAt = now + RESPAWN_MIN_MS + Math.random() * (RESPAWN_MAX_MS - RESPAWN_MIN_MS);
          } else if (now >= s.respawnAt) {
            streams[c] = { ...makeStream(false), active: true };
          }
          continue;
        }

        // Continuous glide.
        s.headPx += (FALL_PX_PER_SEC * dt) / 1000;

        // Shift a fresh glyph into the head each time it crosses into a new cell.
        const cellNow = Math.floor(s.headPx / FONT_PX);
        for (let k = s.cell; k < cellNow; k += 1) {
          s.chars.unshift(randGlyph());
          s.chars.pop();
        }
        s.cell = cellNow;

        // Slow inner shimmer, independent of the fall.
        if (now >= s.nextMutate) {
          s.chars[1 + Math.floor(Math.random() * TRAIL)] = randGlyph();
          s.nextMutate = now + GLYPH_MUTATE_MS * (0.6 + Math.random() * 0.8);
        }

        if (s.headPx - TRAIL * FONT_PX > height) {
          s.active = false;
          s.respawnAt = 0;
          continue;
        }

        // Draw head + tail; brightness is the screen-position envelope, with a light tail fade
        // and a brighter honey head so it still reads as a leading glyph.
        for (let t = 0; t <= TRAIL; t += 1) {
          const y = s.headPx - t * FONT_PX;
          const env = envelope(y / height);
          const tail = t === 0 ? 1 : 1 - 0.5 * (t / TRAIL);
          drawGlyph(
            s.chars[t] ?? 0,
            x,
            y,
            GLOBAL_ALPHA * env * tail,
            t === 0 ? headColor : s.color
          );
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
