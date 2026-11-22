import { Container, Rectangle, Sprite, Texture, Ticker } from "pixi.js";
import type { AtlStatement, TransformDef } from "../types/game-data";
import type { AssetLoader } from "./AssetLoader";
import { ImageDissolveFilter } from "./shaders/ImageDissolveFilter";
import { createBloodEmitter, createRectCluster, createRectStatic } from "./SpecialEffects";
import { LOGICAL_HEIGHT, LOGICAL_WIDTH } from "./Stage";
import { getWarper, type WarperFn } from "./warpers";

export type AtlEventName = "show" | "replace" | "hide" | "none";

export interface AtlState {
  xpos: number;
  xposRel: boolean;
  ypos: number;
  yposRel: boolean;
  xanchor: number;
  xanchorRel: boolean;
  yanchor: number;
  yanchorRel: boolean;
  xoffset: number;
  yoffset: number;
  zoom: number;
  xzoom: number;
  yzoom: number;
  rotate: number;
  alpha: number;
  additive: number;
  xtile: number;
  ytile: number;
  size: [number, number] | null;
}

export function createDefaultAtlState(): AtlState {
  return {
    xpos: 0,
    xposRel: false,
    ypos: 0,
    yposRel: false,
    xanchor: 0,
    xanchorRel: false,
    yanchor: 0,
    yanchorRel: false,
    xoffset: 0,
    yoffset: 0,
    zoom: 1,
    xzoom: 1,
    yzoom: 1,
    rotate: 0,
    alpha: 1,
    additive: 0,
    xtile: 1,
    ytile: 1,
    size: null,
  };
}

export interface AtlRuntimeContext {
  assets: AssetLoader;
  ticker: Ticker;
  transformDefs: Record<string, TransformDef>;
  evalExpr: (expr: string, locals: Record<string, number>) => number;
  parentWidth?: number;
  parentHeight?: number;
  wrapContent?: boolean;
}

interface ActiveInterp {
  key: string;
  from: number;
  to: number;
  rel?: boolean;
  duration: number;
  elapsed: number;
  warper: WarperFn;
}

const KNOWN_POS_KEYWORDS = new Set(["truecenter", "center", "topleft"]);

/**
 * Splits comma-separated arguments respecting nested parentheses/quotes.
 */
function splitArgs(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      cur += ch;
      if (ch === quote && raw[i - 1] !== "\\") {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      cur += ch;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth = Math.max(0, depth - 1);
      cur += ch;
    } else if (ch === "," && depth === 0) {
      if (cur.trim()) {
        out.push(cur.trim());
      }
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) {
    out.push(cur.trim());
  }
  return out;
}

type CompiledAtlExpr = (
  locals: Record<string, number>,
  fallbackEval?: (expr: string) => number,
) => number;

const compiledAtlExprCache = new Map<string, CompiledAtlExpr>();
const PLAIN_ATL_NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const SINGLE_ATL_IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Compiles and caches a numeric Ren'Py ATL expression once per unique expression text.
 */
export function compileAtlNumber(expr: string): CompiledAtlExpr {
  const trimmed = expr.trim();
  const cached = compiledAtlExprCache.get(trimmed);
  if (cached) {
    return cached;
  }

  let compiled: CompiledAtlExpr;
  if (!trimmed || trimmed === "False" || trimmed === "None") {
    compiled = () => 0;
  } else if (trimmed === "True") {
    compiled = () => 1;
  } else if (PLAIN_ATL_NUMBER_RE.test(trimmed)) {
    const num = parseFloat(trimmed);
    compiled = Number.isNaN(num) ? () => 0 : () => num;
  } else if (SINGLE_ATL_IDENT_RE.test(trimmed)) {
    compiled = (locals, fallbackEval) => {
      if (trimmed in locals) {
        return locals[trimmed];
      }
      if (fallbackEval) {
        const val = fallbackEval(trimmed);
        if (Number.isFinite(val)) {
          return val;
        }
      }
      return 0;
    };
  } else {
    const ids: string[] = [];
    const paramById = new Map<string, string>();
    const body = trimmed.replace(/\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g, (id) => {
      let param = paramById.get(id);
      if (!param) {
        param = `v${ids.length}`;
        paramById.set(id, param);
        ids.push(id);
      }
      return param;
    });
    const sanitizedCheck = trimmed.replace(/\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g, "0");

    let fn: ((...args: number[]) => unknown) | null = null;
    if (/^[0-9eE.+\-*/()\s]+$/.test(sanitizedCheck)) {
      try {
        const params = ids.map((id) => paramById.get(id)!);
        fn = new Function(...params, `"use strict"; return (${body});`) as (
          ...args: number[]
        ) => unknown;
      } catch {
        fn = null;
      }
    }

    if (fn) {
      const compiledFn = fn;
      compiled = (locals, fallbackEval) => {
        const args = new Array<number>(ids.length);
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          if (id in locals) {
            args[i] = locals[id];
          } else if (fallbackEval) {
            const val = fallbackEval(id);
            args[i] = Number.isFinite(val) ? val : NaN;
          } else {
            args[i] = NaN;
          }
        }
        try {
          const res = Number(compiledFn(...args));
          if (Number.isFinite(res)) {
            return res;
          }
        } catch {
          // fall through
        }
        const parsed = parseFloat(trimmed);
        return Number.isNaN(parsed) ? 0 : parsed;
      };
    } else {
      const parsed = parseFloat(trimmed);
      const fallback = Number.isNaN(parsed) ? 0 : parsed;
      compiled = () => fallback;
    }
  }

  compiledAtlExprCache.set(trimmed, compiled);
  return compiled;
}

/**
 * Evaluates a numeric Ren'Py ATL expression using current locals + VM fallback.
 */
export function evaluateAtlNumber(
  expr: string,
  locals: Record<string, number>,
  fallbackEval?: (expr: string) => number,
): number {
  return compileAtlNumber(expr)(locals, fallbackEval);
}

function isRelativePositionExpr(rawExpr: string, val: number): boolean {
  const s = rawExpr.trim();
  if (s === "True" || s === "False") {
    return false;
  }
  if (s.includes(".")) {
    return true;
  }
  return Math.abs(val) > 0 && Math.abs(val) < 1;
}

/**
 * Applies `AtlState` onto a Pixi Container (`node`) + optional inner `contentHolder`.
 */
export function syncStateToNode(
  node: Container,
  contentHolder: Container,
  state: AtlState,
  baseWidth: number,
  baseHeight: number,
  parentWidth = LOGICAL_WIDTH,
  parentHeight = LOGICAL_HEIGHT,
): void {
  let scaleX = state.zoom * state.xzoom;
  let scaleY = state.zoom * state.yzoom;

  if (state.size && baseWidth > 0 && baseHeight > 0) {
    scaleX *= state.size[0] / baseWidth;
    scaleY *= state.size[1] / baseHeight;
  }

  const px = state.xposRel ? state.xpos * parentWidth : state.xpos;
  const py = state.yposRel ? state.ypos * parentHeight : state.ypos;
  const ax = state.xanchorRel ? state.xanchor * baseWidth : state.xanchor;
  const ay = state.yanchorRel ? state.yanchor * baseHeight : state.yanchor;

  let xoff = state.xoffset;
  let yoff = state.yoffset;
  if (state.xtile > 1 && baseWidth > 0) {
    xoff = ((xoff % baseWidth) + baseWidth) % baseWidth;
    if (xoff > 0) xoff -= baseWidth;
  }
  if (state.ytile > 1 && baseHeight > 0) {
    yoff = ((yoff % baseHeight) + baseHeight) % baseHeight;
    if (yoff > 0) yoff -= baseHeight;
  }

  node.pivot.set(ax, ay);
  node.scale.set(scaleX, scaleY);
  node.position.set(px + xoff, py + yoff);
  node.angle = state.rotate;
  node.alpha = Math.max(0, Math.min(1, state.alpha));

  if (state.additive > 0) {
    node.blendMode = "add";
    if (contentHolder !== node) {
      contentHolder.alpha = Math.max(0, Math.min(1, state.additive));
    }
  } else {
    node.blendMode = "normal";
    if (contentHolder !== node) {
      contentHolder.alpha = 1;
    }
  }
}

interface TimelineThread {
  tick(dt: number): boolean;
}

/**
 * Full Ren'Py ATL block executor driving PixiJS containers frame-by-frame.
 */
export class AtlRunner {
  public readonly state: AtlState;
  private readonly contentHolder: Container;
  private tileHolder: Container | null = null;
  private baseWidth: number;
  private baseHeight: number;
  private currentContentKey = "";
  private baseTexture: Texture | null = null;
  private baseChildNode: Container | null = null;
  private rootThread: TimelineThread | null = null;
  private tickFn: ((t: Ticker) => void) | null = null;
  private destroyHook: (() => void) | null = null;
  private disposed = false;
  private wasAttached = false;
  private onComplete?: () => void;

  public constructor(
    private readonly node: Container,
    private readonly ctx: AtlRuntimeContext,
    initialState?: Partial<AtlState>,
    baseDims?: { width: number; height: number },
  ) {
    this.state = { ...createDefaultAtlState(), ...initialState };
    if (ctx.wrapContent === false) {
      this.contentHolder = node;
    } else if (
      node.children.length === 1 &&
      node.children[0].label === "atl-content-holder"
    ) {
      this.contentHolder = node.children[0] as Container;
    } else {
      this.contentHolder = new Container({ label: "atl-content-holder" });
      while (node.children.length > 0) {
        const ch = node.removeChildAt(0);
        this.contentHolder.addChild(ch);
      }
      node.addChild(this.contentHolder);
    }

    const bounds = this.contentHolder.getLocalBounds();
    this.baseWidth =
      baseDims?.width ?? (bounds.width > 0 ? bounds.width : LOGICAL_WIDTH);
    this.baseHeight =
      baseDims?.height ?? (bounds.height > 0 ? bounds.height : LOGICAL_HEIGHT);
  }

  public start(
    steps: AtlStatement[],
    eventName: AtlEventName = "show",
    locals: Record<string, number> = {},
    onComplete?: () => void,
  ): void {
    this.stop();
    this.onComplete = onComplete;
    this.disposed = false;
    this.wasAttached = Boolean(this.node.parent);
    this.rootThread = this.createBlockThread(steps, eventName, { ...locals });

    // Advance dt=0 once immediately so t=0 initial properties & initial expressions apply synchronously
    const done = this.stepFrame(0);
    if (done) {
      this.finish();
      return;
    }

    const tick = (t: Ticker): void => {
      if (this.node.parent) {
        this.wasAttached = true;
      } else if (this.wasAttached) {
        this.stop();
        return;
      }
      if (this.disposed || this.node.destroyed) {
        this.stop();
        return;
      }
      const isDone = this.stepFrame(t.deltaMS / 1000);
      if (isDone) {
        this.finish();
      }
    };
    this.tickFn = tick;
    const onDestroyed = (): void => {
      this.stop();
    };
    this.destroyHook = onDestroyed;
    this.node.once("destroyed", onDestroyed);
    this.ctx.ticker.add(tick);
  }

  public stop(): void {
    this.disposed = true;
    if (this.destroyHook) {
      this.node.off("destroyed", this.destroyHook);
      this.destroyHook = null;
    }
    if (this.tickFn) {
      this.ctx.ticker.remove(this.tickFn);
      this.tickFn = null;
    }
    this.rootThread = null;
  }

  private finish(): void {
    if (this.destroyHook) {
      this.node.off("destroyed", this.destroyHook);
      this.destroyHook = null;
    }
    if (this.tickFn) {
      this.ctx.ticker.remove(this.tickFn);
      this.tickFn = null;
    }
    this.rootThread = null;
    this.onComplete?.();
  }

  private stepFrame(dt: number): boolean {
    if (!this.rootThread) {
      return true;
    }
    const done = this.rootThread.tick(dt);
    syncStateToNode(
      this.node,
      this.contentHolder,
      this.state,
      this.baseWidth,
      this.baseHeight,
      this.ctx.parentWidth ?? LOGICAL_WIDTH,
      this.ctx.parentHeight ?? LOGICAL_HEIGHT,
    );
    return done;
  }

  private rebuildTiles(): void {
    if (this.state.xtile <= 1 && this.state.ytile <= 1) {
      if (this.tileHolder) {
        this.contentHolder.removeChild(this.tileHolder);
        this.tileHolder.destroy({ children: true });
        this.tileHolder = null;
      }
      if (this.baseChildNode) {
        this.baseChildNode.visible = true;
      }
      return;
    }

    const nx = Math.max(1, Math.min(12, Math.round(this.state.xtile)));
    const ny = Math.max(1, Math.min(12, Math.round(this.state.ytile)));
    if (!this.baseTexture) {
      return;
    }
    if (this.baseChildNode) {
      this.baseChildNode.visible = false;
    }
    if (!this.tileHolder) {
      this.tileHolder = new Container({ label: "atl-tile-holder" });
      this.contentHolder.addChild(this.tileHolder);
    } else {
      this.tileHolder.removeChildren();
    }

    const w = this.baseWidth || LOGICAL_WIDTH;
    const h = this.baseHeight || LOGICAL_HEIGHT;
    for (let ix = 0; ix < nx + (nx > 1 ? 1 : 0); ix++) {
      for (let iy = 0; iy < ny + (ny > 1 ? 1 : 0); iy++) {
        const sp = new Sprite(this.baseTexture);
        sp.position.set(ix * w, iy * h);
        this.tileHolder.addChild(sp);
      }
    }
  }

  private setChildContent(newNode: Container, cacheKey: string, tex?: Texture): void {
    this.currentContentKey = cacheKey;
    if (this.tileHolder) {
      this.contentHolder.removeChild(this.tileHolder);
      this.tileHolder.destroy({ children: true });
      this.tileHolder = null;
    }
    this.contentHolder.removeChildren();
    this.contentHolder.addChild(newNode);
    this.baseChildNode = newNode;

    if (tex) {
      this.baseTexture = tex;
    } else {
      const firstSprite = newNode.children.find(
        (c): c is Sprite => c instanceof Sprite,
      );
      this.baseTexture = firstSprite?.texture ?? null;
    }

    const bounds = newNode.getLocalBounds();
    if (bounds.width > 0) this.baseWidth = bounds.width;
    if (bounds.height > 0) this.baseHeight = bounds.height;

    if (this.state.xtile > 1 || this.state.ytile > 1) {
      this.rebuildTiles();
    }
  }

  private resolveAndShowExpression(
    exprRaw: string,
    withExpr: string | null,
    parentThreadRef: { addChildAnim?: (dur: number, fn: (p: number) => void) => void },
  ): void {
    const trimmed = exprRaw.trim();
    if (!trimmed || KNOWN_POS_KEYWORDS.has(trimmed)) {
      return;
    }
    if (trimmed === this.currentContentKey) {
      return;
    }

    // Handle Text("...", style="...")
    const textMatch = /^Text\("([^"]*)"(?:,\s*style="([^"]+)")?/.exec(trimmed);
    if (textMatch) {
      const styleName = textMatch[2] || "";
      const txt = textMatch[1];
      void this.ctx.assets
        .buildFromDef(
          {
            kind: "text",
            parameterized: false,
            text: txt,
            props: {},
          },
          { ticker: this.ctx.ticker },
          styleName,
        )
        .then((built) => {
          if (this.disposed || this.node.destroyed) return;
          this.swapWithTransition(built, trimmed, withExpr, parentThreadRef);
        });
      return;
    }

    // Handle RectCluster(...) / RectStatic(...)
    const rcMatch = /^RectCluster\(([^)]+)\)/.exec(trimmed);
    if (rcMatch) {
      const args = splitArgs(rcMatch[1]);
      const count = args[1] ? Number(args[1]) || 12 : 12;
      const aw = args[2] ? Number(args[2]) || 30 : 30;
      const ah = args[3] ? Number(args[3]) || 30 : 30;
      const built = createRectCluster(this.ctx.ticker, count, aw, ah);
      this.setChildContent(built, trimmed);
      return;
    }

    const rsMatch = /^RectStatic\((.+)\)\.sm$/.exec(trimmed);
    if (rsMatch) {
      const args = splitArgs(rsMatch[1]);
      const count = args[1] ? Number(args[1]) || 12 : 12;
      const rw = args[2] ? Number(args[2]) || 32 : 32;
      const rh = args[3] ? Number(args[3]) || 32 : 32;
      const disp = args[0] ?? "";
      const cropScale = /im\.Crop\("([^"]+)"\s*,\s*\(([^)]+)\)\)/.exec(disp);
      if (cropScale) {
        const texPath = cropScale[1];
        const coords = cropScale[2].split(",").map((n) => parseFloat(n.trim()) || 0);
        void this.ctx.assets.loadTexture(texPath).then((baseTex) => {
          if (this.disposed || this.node.destroyed) return;
          const cropped = new Texture({
            source: baseTex.source,
            frame: new Rectangle(
              coords[0] ?? 0,
              coords[1] ?? 0,
              coords[2] ?? rw,
              coords[3] ?? rh,
            ),
          });
          const built = createRectStatic(this.ctx.ticker, count, rw, rh, cropped);
          this.setChildContent(built, trimmed);
        });
      } else {
        const built = createRectStatic(this.ctx.ticker, count, rw, rh);
        this.setChildContent(built, trimmed);
      }
      return;
    }

    // Handle Solid("#hex"), Blood(...), and AnimatedMask(...) inline ATL expressions
    const solidM = /^Solid\(["']([^"']+)["']\)/.exec(trimmed);
    if (solidM) {
      const hex = solidM[1].startsWith("#") ? solidM[1] : `#${solidM[1]}`;
      void this.ctx.assets
        .buildFromDef({ kind: "color", hex }, { ticker: this.ctx.ticker }, trimmed)
        .then((built) => {
          if (this.disposed || this.node.destroyed) return;
          this.swapWithTransition(built, trimmed, withExpr, parentThreadRef);
        });
      return;
    }

    const bloodM = /^Blood\(([^)]+)\)/.exec(trimmed);
    if (bloodM) {
      const args = splitArgs(bloodM[1]);
      let dripChance = 0.05;
      let burstSize = 100;
      let numSquirts = 4;
      for (const a of args.slice(1)) {
        const kv = /^([a-zA-Z_]+)\s*=\s*(.+)$/.exec(a);
        if (!kv) continue;
        const val = parseFloat(kv[2]);
        if (!Number.isFinite(val)) continue;
        if (kv[1] === "dripChance") dripChance = val;
        else if (kv[1] === "burstSize") burstSize = val;
        else if (kv[1] === "numSquirts") numSquirts = val;
      }
      const built = createBloodEmitter(this.ctx.assets, this.ctx.ticker, {
        dripChance,
        burstSize,
        numSquirts,
      });
      this.setChildContent(built, trimmed);
      return;
    }

    const maskM = /^AnimatedMask\((.+)\)$/.exec(trimmed);
    if (maskM) {
      const args = splitArgs(maskM[1]);
      const unq = (s: string | undefined) => (s ?? "").trim().replace(/^["']|["']$/g, "");
      const getNum = (key: string, idx: number, def: number): number => {
        const kw = args.find((a) => a.startsWith(`${key}=`));
        if (kw) return parseFloat(kw.slice(key.length + 1)) || def;
        if (args[idx] && !args[idx].includes("=")) return parseFloat(args[idx]) || def;
        return def;
      };
      const movingArg = args.find((a) => a.startsWith("moving="));
      const moving = movingArg ? movingArg.includes("True") : false;
      void this.ctx.assets
        .buildFromDef(
          {
            kind: "animatedMask",
            child: { kind: "file", path: unq(args[0]) },
            mask: unq(args[1]),
            maskb: unq(args[2]),
            oc: getNum("oc", 3, 0.15),
            op: getNum("op", 4, 16),
            moving,
            speed: getNum("speed", 6, 10),
            frequency: getNum("frequency", 7, 0.25),
            amount: getNum("amount", 8, 0.1),
          },
          { ticker: this.ctx.ticker },
          trimmed,
        )
        .then((built) => {
          if (this.disposed || this.node.destroyed) return;
          this.swapWithTransition(built, trimmed, withExpr, parentThreadRef);
        });
      return;
    }

    const cleanName = trimmed.replace(/^["']|["']$/g, "");
    if (!cleanName) {
      return;
    }

    void this.ctx.assets
      .buildDisplayable(cleanName, {
        ticker: this.ctx.ticker,
      })
      .then((built) => {
        if (this.disposed || this.node.destroyed) {
          return;
        }
        this.swapWithTransition(built, cleanName, withExpr, parentThreadRef);
      });
  }

  private swapWithTransition(
    newNode: Container,
    cacheKey: string,
    withExpr: string | null,
    parentThreadRef: { addChildAnim?: (dur: number, fn: (p: number) => void) => void },
  ): void {
    if (!withExpr) {
      this.setChildContent(newNode, cacheKey);
      return;
    }

    const dissolveM = /^Dissolve\(([0-9.]+)/.exec(withExpr);
    if (dissolveM) {
      const dur = Math.max(0.05, parseFloat(dissolveM[1]) || 0.5);
      // Crossfade old -> new cleanly by overlaying newNode with alpha 0 -> 1 over old children
      const prevChildren = this.contentHolder.children.slice();
      newNode.alpha = 0;
      this.contentHolder.addChild(newNode);
      const b = newNode.getLocalBounds();
      if (b.width > 0) this.baseWidth = b.width;
      if (b.height > 0) this.baseHeight = b.height;
      this.currentContentKey = cacheKey;

      parentThreadRef.addChildAnim?.(dur, (p) => {
        newNode.alpha = p;
        if (p >= 1) {
          for (const old of prevChildren) {
            if (old.parent === this.contentHolder) {
              this.contentHolder.removeChild(old);
            }
          }
        }
      });
      return;
    }

    const imgDissM = /^ImageDissolve\("([^"]+)"\s*,\s*([0-9.]+)(?:.*ramplen=([0-9]+))?/.exec(
      withExpr,
    );
    if (imgDissM) {
      const maskPath = imgDissM[1];
      const dur = Math.max(0.05, parseFloat(imgDissM[2]) || 1.0);
      const ramplen = imgDissM[3] ? parseInt(imgDissM[3], 10) : 8;
      void this.ctx.assets.loadTexture(maskPath).then((maskTex) => {
        if (this.disposed || this.node.destroyed) return;
        const prevChildren = this.contentHolder.children.slice();
        const filter = new ImageDissolveFilter(maskTex, ramplen / 256.0, false);
        newNode.filters = [filter];
        this.contentHolder.addChild(newNode);
        const b = newNode.getLocalBounds();
        if (b.width > 0) this.baseWidth = b.width;
        if (b.height > 0) this.baseHeight = b.height;
        this.currentContentKey = cacheKey;

        parentThreadRef.addChildAnim?.(dur, (p) => {
          filter.progress = p;
          if (p >= 1) {
            newNode.filters = [];
            for (const old of prevChildren) {
              if (old.parent === this.contentHolder) {
                this.contentHolder.removeChild(old);
              }
            }
          }
        });
      });
      return;
    }

    this.setChildContent(newNode, cacheKey);
  }

  private createBlockThread(
    statements: AtlStatement[],
    eventName: AtlEventName,
    locals: Record<string, number>,
  ): TimelineThread {
    const childAnims: Array<{ elapsed: number; duration: number; fn: (p: number) => void }> = [];
    const threadHost = {
      addChildAnim: (dur: number, fn: (p: number) => void) => {
        childAnims.push({ elapsed: 0, duration: dur, fn });
      },
    };

    let idx = 0;
    let totalElapsed = 0;
    let repeatRemaining: number | null = null;
    let repeatInitialized = false;
    let activeStep: {
      duration: number;
      elapsed: number;
      interps: ActiveInterp[];
    } | null = null;
    let activeSubThreads: TimelineThread[] | null = null;
    let functionPollWait = 0;

    const blockCompiledExprs = new Map<string, CompiledAtlExpr>();
    const evalNum = (raw: string): number => {
      let fn = blockCompiledExprs.get(raw);
      if (!fn) {
        fn = compileAtlNumber(raw);
        blockCompiledExprs.set(raw, fn);
      }
      return fn(locals, (e) => this.ctx.evalExpr(e, locals));
    };

    // Precompute `time T` checkpoints when the block starts instead of compiling every frame
    const timeCheckpoints: Array<{ index: number; deadline: number }> = [];
    for (let k = 0; k < statements.length; k++) {
      if (statements[k].type === "time") {
        const ts = statements[k] as Extract<AtlStatement, { type: "time" }>;
        timeCheckpoints.push({ index: k, deadline: evalNum(ts.time) });
      }
    }

    // Find next `time T` checkpoint index after `idx` so preceding loops preempt on schedule
    const findNextTimeDeadline = (fromIndex: number): number | null => {
      for (const cp of timeCheckpoints) {
        if (cp.index >= fromIndex) {
          return cp.deadline;
        }
      }
      return null;
    };

    const applyPropertyImmediate = (prop: string, rawVal: string): void => {
      const s = this.state;
      if (prop === "xcenter") {
        s.xpos = evalNum(rawVal);
        s.xposRel = isRelativePositionExpr(rawVal, s.xpos);
        s.xanchor = 0.5;
        s.xanchorRel = true;
      } else if (prop === "ycenter") {
        s.ypos = evalNum(rawVal);
        s.yposRel = isRelativePositionExpr(rawVal, s.ypos);
        s.yanchor = 0.5;
        s.yanchorRel = true;
      } else if (prop === "xalign") {
        const v = evalNum(rawVal);
        s.xpos = v;
        s.xposRel = true;
        s.xanchor = v;
        s.xanchorRel = true;
      } else if (prop === "yalign") {
        const v = evalNum(rawVal);
        s.ypos = v;
        s.yposRel = true;
        s.yanchor = v;
        s.yanchorRel = true;
      } else if (prop === "xpos") {
        s.xpos = evalNum(rawVal);
        s.xposRel = isRelativePositionExpr(rawVal, s.xpos);
      } else if (prop === "ypos") {
        s.ypos = evalNum(rawVal);
        s.yposRel = isRelativePositionExpr(rawVal, s.ypos);
      } else if (prop === "xanchor") {
        s.xanchor = evalNum(rawVal);
        s.xanchorRel = isRelativePositionExpr(rawVal, s.xanchor);
      } else if (prop === "yanchor") {
        s.yanchor = evalNum(rawVal);
        s.yanchorRel = isRelativePositionExpr(rawVal, s.yanchor);
      } else if (prop === "pos" || prop === "anchor") {
        const m = /^\(([^,]+),\s*([^)]+)\)$/.exec(rawVal.trim());
        if (m) {
          const x = evalNum(m[1]);
          const y = evalNum(m[2]);
          if (prop === "pos") {
            s.xpos = x;
            s.xposRel = isRelativePositionExpr(m[1], x);
            s.ypos = y;
            s.yposRel = isRelativePositionExpr(m[2], y);
          } else {
            s.xanchor = x;
            s.xanchorRel = isRelativePositionExpr(m[1], x);
            s.yanchor = y;
            s.yanchorRel = isRelativePositionExpr(m[2], y);
          }
        }
      } else if (prop === "size") {
        const m = /^\(([^,]+),\s*([^)]+)\)$/.exec(rawVal.trim());
        if (m) {
          s.size = [evalNum(m[1]), evalNum(m[2])];
        }
      } else if (prop === "xoffset") {
        s.xoffset = evalNum(rawVal);
      } else if (prop === "yoffset") {
        s.yoffset = evalNum(rawVal);
      } else if (prop === "zoom") {
        s.zoom = evalNum(rawVal);
      } else if (prop === "xzoom") {
        s.xzoom = evalNum(rawVal);
      } else if (prop === "yzoom") {
        s.yzoom = evalNum(rawVal);
      } else if (prop === "rotate") {
        s.rotate = evalNum(rawVal);
      } else if (prop === "alpha") {
        s.alpha = evalNum(rawVal);
      } else if (prop === "additive") {
        s.additive = evalNum(rawVal);
      } else if (prop === "xtile") {
        s.xtile = Math.max(1, Math.round(evalNum(rawVal)));
        this.rebuildTiles();
      } else if (prop === "ytile") {
        s.ytile = Math.max(1, Math.round(evalNum(rawVal)));
        this.rebuildTiles();
      }
    };

    const startStep = (stmt: Extract<AtlStatement, { type: "step" }>): void => {
      let duration = stmt.duration ? Math.max(0, evalNum(stmt.duration)) : 0;
      const warper = getWarper(stmt.warper);

      // Run step expressions (positional keywords, numeric pauses, image changes, nested transform calls)
      for (const ex of stmt.expressions ?? []) {
        const e = ex.expr.trim();
        if (e === "truecenter" || e === "center") {
          this.state.xpos = 0.5;
          this.state.xposRel = true;
          this.state.ypos = 0.5;
          this.state.yposRel = true;
          this.state.xanchor = 0.5;
          this.state.xanchorRel = true;
          this.state.yanchor = 0.5;
          this.state.yanchorRel = true;
          continue;
        }
        if (e === "topleft") {
          this.state.xpos = 0;
          this.state.xposRel = false;
          this.state.ypos = 0;
          this.state.yposRel = false;
          this.state.xanchor = 0;
          this.state.xanchorRel = false;
          this.state.yanchor = 0;
          this.state.yanchorRel = false;
          continue;
        }

        // Bare numeric or local-arithmetic pause (e.g. `0.20`, `6.0`, `t`, `t + 2.030`)
        const isPauseExpr =
          !e.startsWith('"') &&
          !e.startsWith("'") &&
          !this.ctx.assets.hasImageDef(e) &&
          (/^[0-9]+(?:\.[0-9]+)?$/.test(e) ||
            e in locals ||
            (/^[0-9a-zA-Z_.\s+\-*/()]+$/.test(e) &&
              /[+\-*/]/.test(e) &&
              !e.includes("(")));
        if (isPauseExpr) {
          duration = Math.max(duration, Math.max(0, evalNum(e)));
          continue;
        }

        // Check if expression is a named TransformDef (e.g. `tcommon(200)` or `dizzy(1, 1.0)` or `credits_scroll`)
        const callM = /^([a-zA-Z_][a-zA-Z0-9_]*)(?:\((.*)\))?$/.exec(e);
        if (callM && this.ctx.transformDefs[callM[1]]) {
          const tdef = this.ctx.transformDefs[callM[1]];
          const subLocals: Record<string, number> = { ...locals };
          const argParts = callM[2] ? splitArgs(callM[2]) : [];
          tdef.params.forEach((p, pIdx) => {
            let val: number | undefined;
            const kwArg = argParts.find((a) => a.startsWith(`${p.name}=`));
            if (kwArg) {
              val = evalNum(kwArg.slice(p.name.length + 1));
            } else if (pIdx < argParts.length && !argParts[pIdx].includes("=")) {
              val = evalNum(argParts[pIdx]);
            } else if (p.default !== null) {
              val = evalNum(p.default);
            }
            if (val !== undefined) {
              subLocals[p.name] = val;
            }
          });
          activeSubThreads = [
            this.createBlockThread(tdef.steps, eventName, subLocals),
          ];
          continue;
        }

        this.resolveAndShowExpression(ex.expr, ex.with, threadHost);
      }

      const props = stmt.properties ?? [];
      if (duration <= 0 || !stmt.warper) {
        for (const [prop, valStr] of props) {
          applyPropertyImmediate(prop, valStr);
        }
        if (duration > 0) {
          activeStep = { duration, elapsed: 0, interps: [] };
        }
        return;
      }

      // Timed warper interpolation step
      const interps: ActiveInterp[] = [];
      for (const [prop, valStr] of props) {
        if (prop === "xcenter") {
          const target = evalNum(valStr);
          const rel = isRelativePositionExpr(valStr, target);
          this.state.xanchor = 0.5;
          this.state.xanchorRel = true;
          const fromPx = this.state.xposRel
            ? this.state.xpos * (this.ctx.parentWidth ?? LOGICAL_WIDTH)
            : this.state.xpos;
          this.state.xposRel = false;
          interps.push({
            key: "xpos",
            from: fromPx,
            to: rel ? target * (this.ctx.parentWidth ?? LOGICAL_WIDTH) : target,
            rel: false,
            duration,
            elapsed: 0,
            warper,
          });
        } else if (prop === "ycenter") {
          const target = evalNum(valStr);
          const rel = isRelativePositionExpr(valStr, target);
          this.state.yanchor = 0.5;
          this.state.yanchorRel = true;
          const fromPy = this.state.yposRel
            ? this.state.ypos * (this.ctx.parentHeight ?? LOGICAL_HEIGHT)
            : this.state.ypos;
          this.state.yposRel = false;
          interps.push({
            key: "ypos",
            from: fromPy,
            to: rel ? target * (this.ctx.parentHeight ?? LOGICAL_HEIGHT) : target,
            rel: false,
            duration,
            elapsed: 0,
            warper,
          });
        } else if (prop === "xalign") {
          const target = evalNum(valStr);
          const fromX = this.state.xposRel
            ? this.state.xpos
            : this.state.xpos / (this.ctx.parentWidth ?? LOGICAL_WIDTH);
          interps.push({
            key: "xalign",
            from: fromX,
            to: target,
            rel: true,
            duration,
            elapsed: 0,
            warper,
          });
        } else if (prop === "yalign") {
          const target = evalNum(valStr);
          const fromY = this.state.yposRel
            ? this.state.ypos
            : this.state.ypos / (this.ctx.parentHeight ?? LOGICAL_HEIGHT);
          interps.push({
            key: "yalign",
            from: fromY,
            to: target,
            rel: true,
            duration,
            elapsed: 0,
            warper,
          });
        } else if (prop === "xpos") {
          const target = evalNum(valStr);
          const rel = isRelativePositionExpr(valStr, target);
          const parentW = this.ctx.parentWidth ?? LOGICAL_WIDTH;
          const fromPx = this.state.xposRel ? this.state.xpos * parentW : this.state.xpos;
          this.state.xposRel = false;
          interps.push({
            key: "xpos",
            from: fromPx,
            to: rel ? target * parentW : target,
            duration,
            elapsed: 0,
            warper,
          });
        } else if (prop === "ypos") {
          const target = evalNum(valStr);
          const rel = isRelativePositionExpr(valStr, target);
          const parentH = this.ctx.parentHeight ?? LOGICAL_HEIGHT;
          const fromPy = this.state.yposRel ? this.state.ypos * parentH : this.state.ypos;
          this.state.yposRel = false;
          interps.push({
            key: "ypos",
            from: fromPy,
            to: rel ? target * parentH : target,
            duration,
            elapsed: 0,
            warper,
          });
        } else if (
          prop === "xoffset" ||
          prop === "yoffset" ||
          prop === "zoom" ||
          prop === "xzoom" ||
          prop === "yzoom" ||
          prop === "rotate" ||
          prop === "alpha" ||
          prop === "additive"
        ) {
          interps.push({
            key: prop,
            from: this.state[prop],
            to: evalNum(valStr),
            duration,
            elapsed: 0,
            warper,
          });
        } else {
          applyPropertyImmediate(prop, valStr);
        }
      }
      activeStep = { duration, elapsed: 0, interps };
    };

    const applyInterpValue = (it: ActiveInterp, progress: number): void => {
      const p = it.warper(progress);
      const val = it.from + (it.to - it.from) * p;
      if (it.key === "xalign") {
        this.state.xpos = val;
        this.state.xposRel = true;
        this.state.xanchor = val;
        this.state.xanchorRel = true;
      } else if (it.key === "yalign") {
        this.state.ypos = val;
        this.state.yposRel = true;
        this.state.yanchor = val;
        this.state.yanchorRel = true;
      } else if (it.key === "xpos") {
        this.state.xpos = val;
        this.state.xposRel = false;
      } else if (it.key === "ypos") {
        this.state.ypos = val;
        this.state.yposRel = false;
      } else if (
        it.key === "xoffset" ||
        it.key === "yoffset" ||
        it.key === "zoom" ||
        it.key === "xzoom" ||
        it.key === "yzoom" ||
        it.key === "rotate" ||
        it.key === "alpha" ||
        it.key === "additive"
      ) {
        this.state[it.key] = val;
      }
    };

    const runAtlFunction = (fnExpr: string): number => {
      const fn = fnExpr.trim();
      if (fn === "yuripupils_function") {
        this.state.xoffset = -1 + Math.random() * 9 - 4;
        this.state.yoffset = 3 + Math.random() * 6 - 3;
        return Math.random() * 1.2 + 0.3;
      }
      if (fn === "monika_alpha") {
        this.state.alpha = Math.pow(Math.sin(totalElapsed / 8), 64) * 1.4;
        return 0;
      }
      return -1;
    };

    return {
      tick: (dt: number): boolean => {
        totalElapsed += dt;

        // Update any ongoing expression transition animations (Dissolve / ImageDissolve inside ATL)
        for (let i = childAnims.length - 1; i >= 0; i--) {
          const ca = childAnims[i];
          ca.elapsed += dt;
          const p = ca.duration <= 0 ? 1 : Math.min(1, ca.elapsed / ca.duration);
          ca.fn(p);
          if (p >= 1) {
            childAnims.splice(i, 1);
          }
        }

        // Preempt active step/subthreads if upcoming `time T` deadline reached
        const deadline = findNextTimeDeadline(idx);
        if (deadline !== null && totalElapsed >= deadline) {
          // Finish active step cleanly at deadline
          if (activeStep) {
            for (const it of activeStep.interps) {
              applyInterpValue(it, 1);
            }
            activeStep = null;
          }
          activeSubThreads = null;
          while (idx < statements.length && statements[idx].type !== "time") {
            idx += 1;
          }
        }

        let safety = 0;
        while (safety < 200) {
          safety += 1;

          // Step active timed interpolation if running
          if (activeStep) {
            activeStep.elapsed += dt;
            dt = 0;
            const p =
              activeStep.duration <= 0
                ? 1
                : Math.min(1, activeStep.elapsed / activeStep.duration);
            for (const it of activeStep.interps) {
              applyInterpValue(it, p);
            }
            if (p < 1) {
              return false;
            }
            activeStep = null;
          }

          // Step active parallel/nested/on sub-threads if running
          if (activeSubThreads) {
            const subDt = dt;
            dt = 0;
            let allDone = true;
            for (const sub of activeSubThreads) {
              if (!sub.tick(subDt)) {
                allDone = false;
              }
            }
            if (!allDone) {
              return false;
            }
            activeSubThreads = null;
          }

          // Waiting on a periodic ATL function call
          if (functionPollWait > 0) {
            functionPollWait -= dt;
            dt = 0;
            if (functionPollWait > 0) {
              return false;
            }
          }

          if (idx >= statements.length) {
            return childAnims.length === 0;
          }

          const stmt = statements[idx];
          idx += 1;

          if (stmt.type === "step") {
            startStep(stmt as Extract<AtlStatement, { type: "step" }>);
            continue;
          }

          if (stmt.type === "block") {
            const b = stmt as Extract<AtlStatement, { type: "block" }>;
            activeSubThreads = [
              this.createBlockThread(b.statements, eventName, locals),
            ];
            continue;
          }

          if (stmt.type === "parallel") {
            const pStmt = stmt as Extract<AtlStatement, { type: "parallel" }>;
            activeSubThreads = pStmt.blocks.map((blk) =>
              this.createBlockThread(blk, eventName, locals),
            );
            continue;
          }

          if (stmt.type === "choice") {
            const cStmt = stmt as Extract<AtlStatement, { type: "choice" }>;
            const choices = cStmt.choices;
            if (choices.length > 0) {
              const weights = choices.map((c) =>
                typeof c.weight === "number" ? c.weight : evalNum(String(c.weight)),
              );
              const total = weights.reduce((a, b) => a + Math.max(0, b), 0);
              let pick = Math.random() * (total || 1);
              let chosen = choices[0];
              for (let i = 0; i < choices.length; i++) {
                pick -= Math.max(0, weights[i]);
                if (pick <= 0) {
                  chosen = choices[i];
                  break;
                }
              }
              activeSubThreads = [
                this.createBlockThread(chosen.block, eventName, locals),
              ];
            }
            continue;
          }

          if (stmt.type === "on") {
            const onStmt = stmt as Extract<AtlStatement, { type: "on" }>;
            const handler = onStmt.handlers[eventName];
            if (handler && handler.length > 0) {
              activeSubThreads = [
                this.createBlockThread(handler, eventName, locals),
              ];
            }
            continue;
          }

          if (stmt.type === "time") {
            const tStmt = stmt as Extract<AtlStatement, { type: "time" }>;
            const target = evalNum(tStmt.time);
            if (totalElapsed < target) {
              activeStep = {
                duration: target - totalElapsed,
                elapsed: 0,
                interps: [],
              };
            }
            continue;
          }

          if (stmt.type === "repeat") {
            const rStmt = stmt as Extract<AtlStatement, { type: "repeat" }>;
            if (!repeatInitialized) {
              repeatInitialized = true;
              repeatRemaining =
                rStmt.count === null || rStmt.count === undefined
                  ? null
                  : Math.max(0, Number(rStmt.count) - 1);
            } else if (repeatRemaining !== null) {
              repeatRemaining -= 1;
            }
            if (repeatRemaining === null || repeatRemaining > 0) {
              idx = 0;
              if (dt <= 0) {
                // Prevent infinite zero-dt spin within one frame on 0-duration repeats
                return false;
              }
            }
            continue;
          }

          if (stmt.type === "function") {
            const fStmt = stmt as Extract<AtlStatement, { type: "function" }>;
            const nextDelay = runAtlFunction(fStmt.expr);
            if (nextDelay === 0) {
              // Run again on next frame
              idx -= 1;
              return false;
            }
            if (nextDelay > 0) {
              functionPollWait = nextDelay;
              idx -= 1;
              return false;
            }
            continue;
          }

          if (stmt.type === "child") {
            const chStmt = stmt as Extract<AtlStatement, { type: "child" }>;
            const childContainer = new Container({ label: "atl-contains-child" });
            this.contentHolder.removeChildren();
            this.contentHolder.addChild(childContainer);
            for (const subBlock of chStmt.blocks) {
              const runner = new AtlRunner(childContainer, {
                ...this.ctx,
                parentWidth: this.baseWidth,
                parentHeight: this.baseHeight,
              });
              runner.start(subBlock, eventName, locals);
            }
            continue;
          }
        }

        return false;
      },
    };
  }
}
