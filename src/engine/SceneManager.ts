import { Container, Graphics, Ticker } from "pixi.js";
import type {
  AtlStatement,
  ImageDef,
  PyExprNode,
  TransformDef,
} from "../types/game-data";
import type { AssetLoader } from "./AssetLoader";
import type { SavedSpriteState } from "./Persistence";
import { ImageDissolveFilter } from "./shaders/ImageDissolveFilter";
import { InvertEffect, TearEffect } from "./SpecialEffects";
import { LOGICAL_HEIGHT, LOGICAL_WIDTH, type Stage } from "./Stage";

interface ShownSprite {
  tag: string;
  imageName: string;
  layerName: string;
  atTransforms: string[];
  isTopLeftOverlay: boolean;
  node: Container;
  baseWidth: number;
  baseHeight: number;
  xcenter: number;
  yanchor: number;
  ypos: number;
  yoffset: number;
  xoffset: number;
  zoom: number;
  alpha: number;
  zorder: number;
  cancelAnim?: () => void;
}

const CHARACTER_BASE_SCALE = 0.8;

const SLOT_POSITIONS: Record<string, number> = {
  t11: 640,
  f11: 640,
  i11: 640,
  h11: 640,
  s11: 640,
  d11: 640,
  l11: 640,
  hf11: 640,
  t21: 400,
  f21: 400,
  i21: 400,
  h21: 400,
  s21: 400,
  d21: 400,
  l21: 400,
  hf21: 400,
  t22: 880,
  f22: 880,
  i22: 880,
  h22: 880,
  s22: 880,
  d22: 880,
  l22: 880,
  hf22: 880,
  t31: 240,
  f31: 240,
  i31: 240,
  h31: 240,
  s31: 240,
  d31: 240,
  l31: 240,
  hf31: 240,
  t32: 640,
  f32: 640,
  i32: 640,
  h32: 640,
  s32: 640,
  d32: 640,
  l32: 640,
  hf32: 640,
  t33: 1040,
  f33: 1040,
  i33: 1040,
  h33: 1040,
  s33: 1040,
  d33: 1040,
  l33: 1040,
  hf33: 1040,
  t41: 200,
  f41: 200,
  i41: 200,
  h41: 200,
  s41: 200,
  d41: 200,
  l41: 200,
  hf41: 200,
  t42: 493,
  f42: 493,
  i42: 493,
  h42: 493,
  s42: 493,
  d42: 493,
  l42: 493,
  hf42: 493,
  t43: 786,
  f43: 786,
  i43: 786,
  h43: 786,
  s43: 786,
  d43: 786,
  l43: 786,
  hf43: 786,
  t44: 1080,
  f44: 1080,
  i44: 1080,
  h44: 1080,
  s44: 1080,
  d44: 1080,
  l44: 1080,
  hf44: 1080,
};

export function easeCubic(t: number): number {
  return 0.5 - Math.cos(Math.PI * t) / 2;
}

export function easeInQuad(t: number): number {
  return t * t;
}

export function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

export function easeInQuint(t: number): number {
  return 1 - Math.pow(1 - t, 5);
}

export function easeInBounce(t: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) {
    return n1 * t * t;
  }
  if (t < 2 / d1) {
    const u = t - 1.5 / d1;
    return n1 * u * u + 0.75;
  }
  if (t < 2.5 / d1) {
    const u = t - 2.25 / d1;
    return n1 * u * u + 0.9375;
  }
  const u = t - 2.625 / d1;
  return n1 * u * u + 0.984375;
}

/**
 * Manages Ren'Py's scene layers, sprites, ATL transforms, transitions,
 * Tear/Invert screen overlays, and serializable scene snapshots.
 */
export class SceneManager {
  private readonly sprites = new Map<string, ShownSprite>();
  private currentBgName: string | null = null;
  private currentBgAt: string[] = [];
  private currentBgNode: Container | null = null;
  private layerAtMap = new Map<string, string[]>();
  private layerCancelFns = new Map<string, () => void>();
  public readonly tear: TearEffect;
  public readonly invert: InvertEffect;
  private evalAstFn?: (node: PyExprNode | null | undefined) => unknown;
  private evalVarFn?: (expr: string) => number;

  public constructor(
    private readonly stage: Stage,
    private readonly assets: AssetLoader,
    _transformDefs: Record<string, TransformDef> = {},
  ) {
    this.tear = new TearEffect(stage);
    this.invert = new InvertEffect(stage);
  }

  public setEvaluators(
    evalAst: (node: PyExprNode | null | undefined) => unknown,
    evalVar: (expr: string) => number,
  ): void {
    this.evalAstFn = evalAst;
    this.evalVarFn = evalVar;
  }

  private getLayerContainer(layerName: string): Container {
    if (layerName === "screens") {
      return this.stage.layers.screens;
    }
    if (layerName === "front" || layerName === "transient") {
      return this.stage.layers.transient;
    }
    if (layerName === "overlay") {
      return this.stage.layers.overlay;
    }
    return this.stage.layers.master;
  }

  public getSnapshotState(): {
    bg: string | null;
    bgAt: string[];
    sprites: SavedSpriteState[];
    layerAt: Record<string, string[]>;
  } {
    const layerAt: Record<string, string[]> = {};
    for (const [k, v] of this.layerAtMap.entries()) {
      layerAt[k] = [...v];
    }
    return {
      bg: this.currentBgName,
      bgAt: [...this.currentBgAt],
      sprites: Array.from(this.sprites.values()).map((s) => ({
        tag: s.tag,
        imageName: s.imageName,
        layerName: s.layerName,
        at: [...s.atTransforms],
        x: s.node.position.x,
        y: s.node.position.y,
        xcenter: s.xcenter,
        ypos: s.ypos,
        yanchor: s.yanchor,
        xoffset: s.xoffset,
        yoffset: s.yoffset,
        zoom: s.node.scale.x,
        alpha: s.node.alpha,
        zorder: s.zorder,
        isTopLeftOverlay: s.isTopLeftOverlay,
      })),
      layerAt,
    };
  }

  public async restoreSnapshot(snapshot: {
    bg: string | null;
    bgAt?: string[];
    sprites: SavedSpriteState[];
    layerAt?: Record<string, string[]>;
  }): Promise<void> {
    this.resetAllLayers();
    if (snapshot.bg) {
      await this.setScene(snapshot.bg, { at: snapshot.bgAt ?? [] });
    }
    for (const sp of snapshot.sprites) {
      await this.restoreSprite(sp);
    }
    if (snapshot.layerAt) {
      for (const [layer, at] of Object.entries(snapshot.layerAt)) {
        this.showLayer(layer, at);
      }
    }
  }

  public resetAllLayers(): void {
    for (const sp of this.sprites.values()) {
      sp.cancelAnim?.();
    }
    this.sprites.clear();
    for (const cancel of this.layerCancelFns.values()) {
      cancel();
    }
    this.layerCancelFns.clear();
    this.layerAtMap.clear();
    this.currentBgName = null;
    this.currentBgAt = [];
    this.currentBgNode = null;
    this.stage.clearSceneLayers();
  }

  private async restoreSprite(saved: SavedSpriteState): Promise<void> {
    const layerContainer = this.getLayerContainer(saved.layerName);
    const node = await this.assets.buildDisplayable(saved.imageName, {
      evalAst: this.evalAstFn,
      ticker: this.stage.app.ticker,
    });
    const isCharacter = ["sayori", "natsuki", "yuri", "monika"].includes(
      saved.tag,
    );
    const bounds = node.getLocalBounds();
    const baseWidth =
      bounds.width > 0 ? bounds.width : isCharacter ? 960 : LOGICAL_WIDTH;
    const baseHeight =
      bounds.height > 0 ? bounds.height : isCharacter ? 960 : LOGICAL_HEIGHT;

    if (saved.isTopLeftOverlay) {
      node.pivot.set(0, 0);
      node.position.set(saved.x, saved.y);
      node.scale.set(saved.zoom);
    } else {
      node.pivot.set(baseWidth * 0.5, baseHeight * saved.yanchor);
      node.position.set(saved.x, saved.y);
      node.scale.set(saved.zoom);
    }
    node.alpha = saved.alpha;
    node.zIndex = saved.zorder;
    layerContainer.sortableChildren = true;
    layerContainer.addChild(node);

    const record: ShownSprite = {
      tag: saved.tag,
      imageName: saved.imageName,
      layerName: saved.layerName,
      atTransforms: [...saved.at],
      isTopLeftOverlay: saved.isTopLeftOverlay,
      node,
      baseWidth,
      baseHeight,
      xcenter: saved.xcenter,
      yanchor: saved.yanchor,
      ypos: saved.ypos,
      xoffset: saved.xoffset,
      yoffset: saved.yoffset,
      zoom: saved.zoom,
      alpha: saved.alpha,
      zorder: saved.zorder,
    };
    this.sprites.set(saved.tag, record);

    // Re-attach continuous looping ATL transforms without replaying one-shot intros
    const continuous = saved.at.filter((name) => {
      const base = name.trim().split("(")[0];
      return (
        base === "panic" ||
        base === "n_cg2_wiggle_loop" ||
        base.startsWith("credits_")
      );
    });
    if (continuous.length > 0) {
      this.attachSpecialAtl(record, continuous);
    }
  }

  public async setScene(
    imageName: string,
    options?: {
      layer?: string;
      at?: string[];
      paramText?: string;
      atl?: AtlStatement[];
    },
  ): Promise<void> {
    for (const sp of this.sprites.values()) {
      sp.cancelAnim?.();
    }
    this.sprites.clear();
    this.stage.layers.master.removeChildren();
    this.stage.layers.transient.removeChildren();
    this.stage.layers.background.removeChildren();

    this.currentBgName = imageName;
    this.currentBgAt = [...(options?.at ?? [])];
    const node = await this.assets.buildDisplayable(imageName, {
      evalAst: this.evalAstFn,
      ticker: this.stage.app.ticker,
      paramText: options?.paramText,
    });
    this.stage.layers.background.addChild(node);
    this.currentBgNode = node;

    if (options?.at && options.at.length > 0) {
      this.applyStaticAtToNode(node, options.at);
    }
    if (options?.atl && options.atl.length > 0) {
      this.applyInlineAtl(node, options.atl);
    }
  }

  public async show(
    imageNameOrTag: string,
    atTransforms: string[] = [],
    options?: {
      tag?: string;
      layer?: string;
      zorder?: string;
      paramText?: string;
      def?: ImageDef;
      atl?: AtlStatement[];
    },
  ): Promise<void> {
    const trimmed = imageNameOrTag.trim();
    const parts = trimmed.split(/\s+/);
    const tag = options?.tag || parts[0] || trimmed;
    const existing = this.sprites.get(tag);
    const layerName = options?.layer || existing?.layerName || "master";
    const layerContainer = this.getLayerContainer(layerName);

    // Handle tag-only `show sayori at s11`: reuse existing displayed pose!
    const isTagOnly =
      !options?.def &&
      !options?.paramText &&
      parts.length === 1 &&
      !this.assets.hasImageDef(trimmed) &&
      !this.assets.resolveGamePath(trimmed) &&
      existing !== undefined;

    let node: Container;
    let resolvedImageName = trimmed;

    if (isTagOnly && existing) {
      node = existing.node;
      resolvedImageName = existing.imageName;
    } else {
      if (options?.def) {
        node = await this.assets.buildFromDef(
          options.def,
          {
            evalAst: this.evalAstFn,
            ticker: this.stage.app.ticker,
            paramText: options.paramText,
          },
          trimmed,
        );
      } else {
        node = await this.assets.buildDisplayable(trimmed, {
          evalAst: this.evalAstFn,
          ticker: this.stage.app.ticker,
          paramText: options?.paramText,
        });
      }
      if (existing) {
        existing.cancelAnim?.();
        this.getLayerContainer(existing.layerName).removeChild(existing.node);
      }
      layerContainer.addChild(node);
    }

    const isCharacter = ["sayori", "natsuki", "yuri", "monika"].includes(tag);
    const bounds = node.getLocalBounds();
    const baseWidth = bounds.width > 0 ? bounds.width : isCharacter ? 960 : LOGICAL_WIDTH;
    const baseHeight = bounds.height > 0 ? bounds.height : isCharacter ? 960 : LOGICAL_HEIGHT;

    let xcenter = existing ? existing.xcenter : LOGICAL_WIDTH / 2;
    let zoom = existing
      ? existing.zoom
      : isCharacter
        ? CHARACTER_BASE_SCALE
        : 1.0;
    let ypos = existing
      ? existing.ypos
      : isCharacter
        ? LOGICAL_HEIGHT * 1.03
        : LOGICAL_HEIGHT / 2;
    let yanchor = existing ? existing.yanchor : isCharacter ? 1.0 : 0.5;
    let xoffset = 0;
    let yoffset = 0;
    let alpha = 1.0;
    let animateFromX: number | null = null;
    let doHop = false;
    let doDip = false;
    let doSink = false;
    let doHideAfter: "thide" | "lhide" | null = null;

    // For non-character overlays/CGs/text without explicit `at`, default to top-left (0, 0).
    const isTopLeftOverlay =
      !isCharacter &&
      atTransforms.length === 0 &&
      !existing &&
      !trimmed.startsWith("credits_") &&
      !trimmed.startsWith("poem_");

    if (isTopLeftOverlay) {
      node.pivot.set(0, 0);
      node.position.set(0, 0);
      node.scale.set(1);
    }

    for (const rawAt of atTransforms) {
      const name = rawAt.trim();
      const callMatch = /^([a-zA-Z0-9_]+)\((.*)\)$/.exec(name);
      const baseName = callMatch ? callMatch[1] : name;
      const argStr = callMatch ? callMatch[2] : "";

      if (baseName in SLOT_POSITIONS) {
        xcenter = SLOT_POSITIONS[baseName];
      }
      if (baseName.startsWith("f") && baseName !== "face") {
        zoom = CHARACTER_BASE_SCALE * 1.05;
      } else if (baseName.startsWith("t") && baseName !== "truecenter" && baseName !== "thide") {
        zoom = CHARACTER_BASE_SCALE;
      } else if (baseName.startsWith("i") || baseName.startsWith("s") || baseName.startsWith("d")) {
        if (baseName !== "sink") {
          zoom = CHARACTER_BASE_SCALE;
        }
      }

      if (baseName.startsWith("h") && baseName !== "hop" && baseName !== "hopfocus") {
        doHop = true;
      }
      if (baseName === "hop") {
        doHop = true;
      }
      if (baseName === "hopfocus") {
        zoom = CHARACTER_BASE_SCALE * 1.05;
        doHop = true;
      }
      if (baseName.startsWith("d") && baseName !== "dizzy") {
        doDip = true;
      }
      if (baseName === "dip") {
        doDip = true;
      }
      if (baseName.startsWith("l") && baseName !== "lhide" && baseName !== "layerflicker") {
        animateFromX = -300;
      }
      if (baseName === "leftin") {
        animateFromX = -300;
      }
      if (
        baseName === "sink" ||
        /^s[1-4][1-4]$/.test(baseName)
      ) {
        doSink = true;
        ypos = LOGICAL_HEIGHT * 1.06;
      } else if (isCharacter && /^([tifhld]|hf)[1-4][1-4]$/.test(baseName)) {
        ypos = LOGICAL_HEIGHT * 1.03;
      }

      if (baseName === "thide") {
        doHideAfter = "thide";
      }
      if (baseName === "lhide") {
        doHideAfter = "lhide";
      }
      if (baseName === "face") {
        yanchor = 1.0;
        xcenter = 640;
        ypos = LOGICAL_HEIGHT * 1.03;
        yoffset = argStr.includes("y=")
          ? this.evalNumeric(argStr.split("y=")[1])
          : 500;
        zoom = CHARACTER_BASE_SCALE * 2.0;
      }
      if (baseName === "truecenter" || baseName === "center") {
        xcenter = LOGICAL_WIDTH / 2;
        ypos = LOGICAL_HEIGHT / 2;
        yanchor = 0.5;
        zoom = 1.0;
      }
      if (baseName === "malpha") {
        xcenter = 640;
        yanchor = 1.0;
        ypos = LOGICAL_HEIGHT * 1.03;
        zoom = CHARACTER_BASE_SCALE;
        alpha = Math.max(0, Math.min(1, this.evalNumeric(argStr || "1.0")));
      }
      if (baseName === "sticker_left") {
        xcenter = 100;
        ypos = LOGICAL_HEIGHT * 0.9;
        yanchor = 0.9;
        zoom = 1.0;
      }
      if (baseName === "sticker_mid") {
        xcenter = 220;
        ypos = LOGICAL_HEIGHT * 0.9;
        yanchor = 0.9;
        zoom = 1.0;
      }
      if (baseName === "sticker_right") {
        xcenter = 340;
        ypos = LOGICAL_HEIGHT * 0.9;
        yanchor = 0.9;
        zoom = 1.0;
      }
      if (baseName === "sticker_glitch") {
        xcenter = 50;
        ypos = LOGICAL_HEIGHT * 1.35;
        yanchor = 0.5;
        zoom = 1.0;
      }
      if (baseName === "sticker_m_glitch") {
        xcenter = 100;
        ypos = LOGICAL_HEIGHT * 1.15;
        yanchor = 0.5;
        zoom = 1.0;
      }
    }

    if (!isTopLeftOverlay) {
      node.pivot.set(baseWidth * 0.5, baseHeight * yanchor);
      node.scale.set(zoom);
      node.position.set(
        (animateFromX ?? xcenter) + xoffset,
        ypos + yoffset,
      );
      node.alpha = alpha;
    }

    const zorder = options?.zorder
      ? parseInt(options.zorder, 10) || 0
      : existing?.zorder ?? 0;
    node.zIndex = zorder;
    layerContainer.sortableChildren = true;

    const record: ShownSprite = {
      tag,
      imageName: resolvedImageName,
      layerName,
      atTransforms:
        atTransforms.length > 0
          ? [...atTransforms]
          : [...(existing?.atTransforms ?? [])],
      isTopLeftOverlay,
      node,
      baseWidth,
      baseHeight,
      xcenter,
      yanchor,
      ypos,
      yoffset,
      xoffset,
      zoom,
      alpha,
      zorder,
    };
    this.sprites.set(tag, record);

    if (options?.atl && options.atl.length > 0) {
      this.applyInlineAtl(node, options.atl);
    }

    // Run continuous or special ATL animations
    this.attachSpecialAtl(record, atTransforms);

    if (doHideAfter === "thide") {
      await this.tween(250, (p) => {
        const e = easeCubic(p);
        node.alpha = 1 - e;
        node.scale.set(zoom * (1 - 0.05 * e));
        node.position.y = ypos - 20 * e;
      });
      this.sprites.delete(tag);
      layerContainer.removeChild(node);
      return;
    }

    if (doHideAfter === "lhide") {
      const startX = node.position.x;
      await this.tween(250, (p) => {
        node.position.x = startX + (-300 - startX) * easeOutQuad(p);
      });
      this.sprites.delete(tag);
      layerContainer.removeChild(node);
      return;
    }

    if (animateFromX !== null) {
      await this.tween(250, (p) => {
        node.position.x = animateFromX + (xcenter - animateFromX) * easeCubic(p);
      });
    } else if (existing && existing.xcenter !== xcenter) {
      const startX = existing.xcenter;
      await this.tween(250, (p) => {
        node.position.x = startX + (xcenter - startX) * easeCubic(p);
      });
    }

    if (doSink) {
      const startY = existing?.ypos ?? LOGICAL_HEIGHT * 1.03;
      node.position.y = startY;
      await this.tween(500, (p) => {
        node.position.y = startY + (LOGICAL_HEIGHT * 1.06 - startY) * easeInQuad(p);
      });
    }

    if (doHop) {
      const baseY = node.position.y;
      await this.tween(100, (p) => {
        node.position.y = baseY - 20 * easeInQuad(p);
      });
      await this.tween(100, (p) => {
        node.position.y = baseY - 20 * (1 - easeOutQuad(p));
      });
    }

    if (doDip) {
      const baseY = node.position.y;
      await this.tween(250, (p) => {
        node.position.y = baseY + 25 * easeInQuad(p);
      });
      await this.tween(250, (p) => {
        node.position.y = baseY + 25 * (1 - easeOutQuad(p));
      });
    }
  }

  private attachSpecialAtl(record: ShownSprite, atTransforms: string[]): void {
    const node = record.node;
    for (const rawAt of atTransforms) {
      const name = rawAt.trim();
      const base = name.split("(")[0];

      if (base === "panic") {
        let elapsed = 0;
        const baseX = record.xcenter;
        const baseY = record.ypos;
        const tick = (t: Ticker): void => {
          elapsed += t.deltaMS / 1000;
          node.position.y = baseY + 12.5 * (1 - Math.cos((elapsed / 1.2) * Math.PI));
          node.position.x = baseX + Math.sin((elapsed / 0.6) * Math.PI) * 20;
        };
        this.stage.app.ticker.add(tick);
        record.cancelAnim = () => this.stage.app.ticker.remove(tick);
      } else if (base === "cgfade") {
        node.alpha = 0;
        void this.tween(500, (p) => {
          node.alpha = p;
        });
      } else if (base === "noise_alpha") {
        node.alpha = 0.25;
      } else if (base === "noisefade" || base === "vignettefade") {
        const targetAlpha = base === "noisefade" ? 0.4 : 1.0;
        const durationMs = base === "noisefade" ? 5000 : 25000;
        node.alpha = 0;
        void this.tween(durationMs, (p) => {
          node.alpha = targetAlpha * p;
        });
      } else if (base === "n_cg2_zoom") {
        node.pivot.set(record.baseWidth * 0.5, record.baseHeight * 0.5);
        node.position.set(LOGICAL_WIDTH / 2, LOGICAL_HEIGHT / 2);
        void this.tween(200, (p) => {
          const e = easeOutQuad(p);
          node.scale.set(1 + 1.5 * e);
          node.position.x = LOGICAL_WIDTH / 2 + 200 * e;
        });
      } else if (base === "n_cg2_wiggle" || base === "n_cg2_wiggle_loop") {
        let elapsed = 0;
        const baseX = node.position.x;
        const tick = (t: Ticker): void => {
          elapsed += t.deltaMS / 1000;
          const phase = elapsed % 2.2;
          if (phase < 1.2) {
            node.position.x = baseX + Math.sin(phase * Math.PI * 3.33) * 15 * (1 - phase / 1.2);
          } else {
            node.position.x = baseX;
            if (base === "n_cg2_wiggle") {
              this.stage.app.ticker.remove(tick);
            }
          }
        };
        this.stage.app.ticker.add(tick);
        record.cancelAnim = () => this.stage.app.ticker.remove(tick);
      } else if (base === "s_kill_bg_start") {
        node.pivot.set(record.baseWidth * 0.5, record.baseHeight * 0.5);
        node.position.set(LOGICAL_WIDTH / 2, LOGICAL_HEIGHT / 2);
        node.scale.set(1.1);
        void this.tween(4000, (p) => {
          node.scale.set(1.1 - 0.1 * p);
        });
      } else if (base === "s_kill_start") {
        node.pivot.set(record.baseWidth * 0.3, record.baseHeight * 0.25);
        node.position.set(LOGICAL_WIDTH * 0.3, LOGICAL_HEIGHT * 0.25);
        node.scale.set(0.8);
        void this.tween(4000, (p) => {
          node.scale.set(0.8 - 0.05 * p);
          node.position.y = LOGICAL_HEIGHT * 0.25 + 10 * p;
        });
      } else if (
        base === "credits_scroll_left" ||
        base === "credits_scroll_right" ||
        base === "credits_text_scroll_left" ||
        base === "credits_text_scroll_right" ||
        base.startsWith("credits_sticker_")
      ) {
        if (base === "credits_scroll_left") {
          node.pivot.set(record.baseWidth * 0.1, 0);
          node.position.set(LOGICAL_WIDTH * 0.1, 740);
        } else if (base === "credits_scroll_right") {
          node.pivot.set(record.baseWidth * 0.9, 0);
          node.position.set(LOGICAL_WIDTH * 0.9, 740);
        } else if (base === "credits_text_scroll_left") {
          node.position.set(320, 920);
        } else if (base === "credits_text_scroll_right") {
          node.position.set(960, 920);
        } else {
          const idx = parseInt(base.slice(-1), 10) || 1;
          const xs = [0.32, 0.44, 0.56, 0.68];
          node.pivot.set(record.baseWidth * 0.5, record.baseHeight);
          node.position.set(LOGICAL_WIDTH * (xs[idx - 1] ?? 0.5), 940);
        }
        const startY = node.position.y;
        const endY = startY - 1120;
        void this.tween(15000, (p) => {
          node.position.y = startY + (endY - startY) * p;
        });
      }
    }
  }

  private applyStaticAtToNode(node: Container, atTransforms: string[]): void {
    for (const rawAt of atTransforms) {
      const name = rawAt.trim();
      if (name === "truecenter" || name === "center") {
        const b = node.getLocalBounds();
        node.pivot.set(b.width * 0.5, b.height * 0.5);
        node.position.set(LOGICAL_WIDTH / 2, LOGICAL_HEIGHT / 2);
      }
    }
  }

  private applyInlineAtl(node: Container, steps: AtlStatement[]): void {
    for (const st of steps) {
      if (st.type !== "step") {
        continue;
      }
      const step = st as Extract<AtlStatement, { type: "step" }>;
      for (const [prop, valStr] of step.properties ?? []) {
        const val = this.evalNumeric(valStr);
        if (prop === "alpha") {
          node.alpha = Math.max(0, Math.min(1, val));
        } else if (prop === "xpos") {
          node.position.x = val <= 1 && valStr.includes(".") ? val * LOGICAL_WIDTH : val;
        } else if (prop === "ypos") {
          node.position.y = val <= 1 && valStr.includes(".") ? val * LOGICAL_HEIGHT : val;
        } else if (prop === "xoffset") {
          node.position.x += val;
        } else if (prop === "yoffset") {
          node.position.y += val;
        } else if (prop === "zoom") {
          node.scale.set(val);
        }
      }
    }
  }

  public showLayer(layerName: string, atTransforms: string[] = []): void {
    const prevCancel = this.layerCancelFns.get(layerName);
    if (prevCancel) {
      prevCancel();
      this.layerCancelFns.delete(layerName);
    }

    if (atTransforms.length === 0) {
      this.layerAtMap.delete(layerName);
    } else {
      this.layerAtMap.set(layerName, [...atTransforms]);
    }

    const container = this.getLayerContainer(layerName);
    container.pivot.set(LOGICAL_WIDTH / 2, LOGICAL_HEIGHT / 2);
    container.position.set(LOGICAL_WIDTH / 2, LOGICAL_HEIGHT / 2);
    container.scale.set(1);

    if (atTransforms.length === 0) {
      return;
    }

    const first = atTransforms[0].trim();
    if (first.startsWith("heartbeat")) {
      let elapsed = 0;
      const tick = (t: Ticker): void => {
        elapsed += t.deltaMS / 1000;
        const beat = Math.pow(Math.sin(elapsed * 2.1), 16);
        container.scale.set(1 + 0.06 * beat);
      };
      this.stage.app.ticker.add(tick);
      this.layerCancelFns.set(layerName, () => {
        this.stage.app.ticker.remove(tick);
        container.scale.set(1);
      });
    } else if (first.startsWith("dizzy")) {
      let elapsed = 0;
      const tick = (t: Ticker): void => {
        elapsed += t.deltaMS / 1000;
        container.position.set(
          LOGICAL_WIDTH / 2 + Math.sin(elapsed * 2.2) * 8,
          LOGICAL_HEIGHT / 2 + Math.cos(elapsed * 1.6) * 5,
        );
      };
      this.stage.app.ticker.add(tick);
      this.layerCancelFns.set(layerName, () => {
        this.stage.app.ticker.remove(tick);
        container.position.set(LOGICAL_WIDTH / 2, LOGICAL_HEIGHT / 2);
      });
    } else if (first.startsWith("rewind")) {
      container.scale.set(1.2);
      let elapsed = 0;
      const tick = (t: Ticker): void => {
        elapsed += t.deltaMS / 1000;
        container.position.set(
          LOGICAL_WIDTH / 2 + Math.sin(elapsed * 16) * 24,
          LOGICAL_HEIGHT / 2 + Math.cos(elapsed * 10) * 16,
        );
      };
      this.stage.app.ticker.add(tick);
      this.layerCancelFns.set(layerName, () => {
        this.stage.app.ticker.remove(tick);
        container.scale.set(1);
        container.position.set(LOGICAL_WIDTH / 2, LOGICAL_HEIGHT / 2);
      });
    } else if (first.startsWith("layerflicker")) {
      let elapsed = 0;
      const tick = (t: Ticker): void => {
        elapsed += t.deltaMS / 1000;
        const zoom = 1 + 0.04 * (Math.sin(elapsed * 8) > 0.5 ? 1 : 0);
        container.scale.set(zoom);
      };
      this.stage.app.ticker.add(tick);
      this.layerCancelFns.set(layerName, () => {
        this.stage.app.ticker.remove(tick);
        container.scale.set(1);
      });
    }
  }

  public async hide(tagOrName: string): Promise<void> {
    const tag = tagOrName.split(/\s+/)[0] || tagOrName;
    const existing = this.sprites.get(tag);
    if (!existing) {
      return;
    }
    existing.cancelAnim?.();
    this.sprites.delete(tag);
    this.getLayerContainer(existing.layerName).removeChild(existing.node);
  }

  public async runTransition(expr: string | null, resolvedMs?: number): Promise<void> {
    if (!expr || expr === "None") {
      return;
    }

    const lower = expr.toLowerCase();

    if (lower === "wipeleft") {
      await this.imageDissolveTransition("images/menu/wipeleft.png", 500);
      return;
    }

    if (lower === "wipeleft_scene") {
      await this.curtainWipeScene("images/menu/wipeleft.png", 500, 250);
      return;
    }

    if (lower.includes("imagedissolve")) {
      const m = /ImageDissolve\("([^"]+)"\s*,\s*([0-9.]+)/i.exec(expr);
      if (m) {
        await this.imageDissolveTransition(m[1], parseFloat(m[2]) * 1000);
        return;
      }
    }

    if (lower === "dissolve_scene_full") {
      await this.fadeBlackCurtain(1000, 1000, 1000);
      return;
    }

    if (lower === "dissolve_scene_half") {
      await this.fadeBlackCurtain(0, 1000, 1000);
      return;
    }

    if (lower === "close_eyes") {
      await this.fadeBlackCurtain(500, 250, 0);
      return;
    }

    if (lower === "open_eyes") {
      await this.fadeBlackCurtain(0, 0, 500);
      return;
    }

    if (lower === "trueblack") {
      await this.pauseMs(250);
      return;
    }

    if (lower === "tpause") {
      await this.pauseMs(250);
      return;
    }

    let durationMs = resolvedMs ?? 250;
    if (lower === "dissolve_cg") {
      durationMs = 750;
    } else if (lower === "dissolve_scene") {
      durationMs = 1000;
    } else if (!resolvedMs) {
      const durationMatch = /([0-9]+(?:\.[0-9]+)?)/.exec(expr);
      if (durationMatch) {
        durationMs = parseFloat(durationMatch[1]) * 1000;
      }
    }

    await this.dissolveTransition(Math.max(40, Math.min(durationMs, 3000)));
  }

  private async dissolveTransition(durationMs: number): Promise<void> {
    if (!this.currentBgNode) {
      return;
    }
    const target = this.stage.layers.background;
    target.alpha = 0;
    await this.tween(durationMs, (p) => {
      target.alpha = p;
    });
    target.alpha = 1;
  }

  private async imageDissolveTransition(
    maskPath: string,
    durationMs: number,
  ): Promise<void> {
    const tex = await this.assets.loadTexture(maskPath);
    const filter = new ImageDissolveFilter(tex, 0.25, false);
    this.stage.layers.background.filters = [filter];
    await this.tween(durationMs, (p) => {
      filter.progress = p;
    });
    this.stage.layers.background.filters = [];
  }

  private async curtainWipeScene(
    maskPath: string,
    wipeMs: number,
    holdMs: number,
  ): Promise<void> {
    const tex = await this.assets.loadTexture(maskPath);
    const curtain = new Graphics();
    curtain.rect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
    curtain.fill({ color: 0x000000, alpha: 1 });
    const filterIn = new ImageDissolveFilter(tex, 0.25, false);
    curtain.filters = [filterIn];
    this.stage.layers.overlay.addChild(curtain);

    await this.tween(wipeMs, (p) => {
      filterIn.progress = p;
    });
    if (holdMs > 0) {
      await this.pauseMs(holdMs);
    }
    const filterOut = new ImageDissolveFilter(tex, 0.25, true);
    curtain.filters = [filterOut];
    await this.tween(wipeMs, (p) => {
      filterOut.progress = 1 - p;
    });

    this.stage.layers.overlay.removeChild(curtain);
    curtain.destroy();
  }

  private async fadeBlackCurtain(
    inMs: number,
    holdMs: number,
    outMs: number,
  ): Promise<void> {
    const veil = new Graphics();
    veil.rect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
    veil.fill({ color: 0x000000, alpha: 1 });
    veil.alpha = inMs > 0 ? 0 : 1;
    this.stage.layers.overlay.addChild(veil);

    if (inMs > 0) {
      await this.tween(inMs, (p) => {
        veil.alpha = p;
      });
    }
    if (holdMs > 0) {
      await this.pauseMs(holdMs);
    }
    if (outMs > 0) {
      await this.tween(outMs, (p) => {
        veil.alpha = 1 - p;
      });
    }

    this.stage.layers.overlay.removeChild(veil);
    veil.destroy();
  }

  private pauseMs(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  private evalNumeric(expr: string): number {
    if (this.evalVarFn) {
      return this.evalVarFn(expr);
    }
    const n = parseFloat(expr);
    return Number.isNaN(n) ? 0 : n;
  }

  private tween(
    durationMs: number,
    onUpdate: (progress: number) => void,
  ): Promise<void> {
    return new Promise((resolve) => {
      const start = performance.now();
      const tick = (now: number): void => {
        const elapsed = now - start;
        const t = durationMs <= 0 ? 1 : Math.min(1, elapsed / durationMs);
        onUpdate(t);
        if (t < 1) {
          requestAnimationFrame(tick);
        } else {
          resolve();
        }
      };
      requestAnimationFrame(tick);
    });
  }
}
