import { Container, Graphics, RenderTexture, Sprite } from "pixi.js";
import type {
  AtlStatement,
  ImageDef,
  PyExprNode,
  TransformDef,
} from "../types/game-data";
import type { AssetLoader } from "./AssetLoader";
import {
  AtlRunner,
  createDefaultAtlState,
  evaluateAtlNumber,
  syncStateToNode,
  type AtlEventName,
  type AtlRuntimeContext,
  type AtlState,
} from "./AtlRunner";
import type { SavedSpriteState } from "./Persistence";
import { ImageDissolveFilter } from "./shaders/ImageDissolveFilter";
import { InvertEffect, TearEffect } from "./SpecialEffects";
import { LOGICAL_HEIGHT, LOGICAL_WIDTH, type Stage } from "./Stage";

export {
  ease as easeCubic,
  easein_quad as easeInQuad,
  easeout_quad as easeOutQuad,
  easein_quint as easeInQuint,
  easein_bounce as easeInBounce,
} from "./warpers";

interface ShownSprite {
  tag: string;
  imageName: string;
  layerName: string;
  atTransforms: string[];
  isTopLeftOverlay: boolean;
  node: Container;
  baseWidth: number;
  baseHeight: number;
  zorder: number;
  runner: AtlRunner;
  hiding: boolean;
}

const CHARACTER_TAGS = new Set(["sayori", "natsuki", "yuri", "monika"]);
const CHARACTER_BASE_SCALE = 0.8;

/**
 * Manages Ren'Py's scene layers, sprites, ATL transforms, true cross-scene
 * transitions, Tear/Invert screen overlays, and serializable scene snapshots.
 */
export class SceneManager {
  private readonly sprites = new Map<string, ShownSprite>();
  private currentBgName: string | null = null;
  private currentBgAt: string[] = [];
  private currentBgNode: Container | null = null;
  private currentBgRunner: AtlRunner | null = null;
  private layerAtMap = new Map<string, string[]>();
  private layerRunners = new Map<string, AtlRunner>();
  private pendingOldFrameTex: RenderTexture | null = null;
  public readonly tear: TearEffect;
  public readonly invert: InvertEffect;
  private evalAstFn?: (node: PyExprNode | null | undefined) => unknown;
  private evalVarFn?: (expr: string) => number;

  public constructor(
    private readonly stage: Stage,
    private readonly assets: AssetLoader,
    private readonly transformDefs: Record<string, TransformDef> = {},
  ) {
    this.tear = new TearEffect(stage);
    this.invert = new InvertEffect(stage);
    this.assets.setAtlConfig(this.transformDefs, (expr) => this.evalNumeric(expr));
  }

  public setEvaluators(
    evalAst: (node: PyExprNode | null | undefined) => unknown,
    evalVar: (expr: string) => number,
  ): void {
    this.evalAstFn = evalAst;
    this.evalVarFn = evalVar;
    this.assets.setAtlConfig(this.transformDefs, (expr) =>
      this.evalNumeric(expr),
    );
  }

  public hasSprite(tag: string): boolean {
    const sp = this.sprites.get(tag);
    return Boolean(sp && !sp.hiding);
  }

  /**
   * Discards any unconsumed pre-mutation frame snapshot at the end of a `with`
   * transition or dialogue/menu/pause beat so the next scene mutation captures fresh.
   */
  public markTransitionCheckpoint(): void {
    if (this.pendingOldFrameTex) {
      this.pendingOldFrameTex.destroy(true);
      this.pendingOldFrameTex = null;
    }
  }

  private captureOldFrameIfNeeded(): void {
    if (this.pendingOldFrameTex || !this.currentBgNode) {
      return;
    }
    const overlayWasVisible = this.stage.layers.overlay.visible;
    const screensWasVisible = this.stage.layers.screens.visible;
    this.stage.layers.overlay.visible = false;
    this.stage.layers.screens.visible = false;
    try {
      const rt = RenderTexture.create({
        width: LOGICAL_WIDTH,
        height: LOGICAL_HEIGHT,
      });
      this.stage.app.renderer.render({
        container: this.stage.app.stage,
        target: rt,
      });
      this.pendingOldFrameTex = rt;
    } finally {
      this.stage.layers.overlay.visible = overlayWasVisible;
      this.stage.layers.screens.visible = screensWasVisible;
    }
  }

  private createAtlContext(wrapContent = true): AtlRuntimeContext {
    return {
      assets: this.assets,
      ticker: this.stage.app.ticker,
      transformDefs: this.transformDefs,
      evalExpr: (expr, locals) =>
        evaluateAtlNumber(expr, locals, (e) => this.evalNumeric(e)),
      wrapContent,
    };
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
      sprites: Array.from(this.sprites.values())
        .filter((s) => !s.hiding)
        .map((s) => {
          const st = s.runner.state;
          const xcenter = st.xposRel ? st.xpos * LOGICAL_WIDTH : st.xpos;
          const ypos = st.yposRel ? st.ypos * LOGICAL_HEIGHT : st.ypos;
          const yanchor = st.yanchorRel
            ? st.yanchor
            : s.baseHeight > 0
              ? st.yanchor / s.baseHeight
              : 1.0;
          return {
            tag: s.tag,
            imageName: s.imageName,
            layerName: s.layerName,
            at: [...s.atTransforms],
            x: s.node.position.x,
            y: s.node.position.y,
            xcenter,
            ypos,
            yanchor,
            xoffset: st.xoffset,
            yoffset: st.yoffset,
            zoom: st.zoom,
            alpha: s.node.alpha,
            zorder: s.zorder,
            isTopLeftOverlay: s.isTopLeftOverlay,
          };
        }),
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
    this.markTransitionCheckpoint();
  }

  public resetAllLayers(): void {
    this.markTransitionCheckpoint();
    for (const sp of this.sprites.values()) {
      sp.runner.stop();
    }
    this.sprites.clear();
    this.currentBgRunner?.stop();
    this.currentBgRunner = null;
    for (const runner of this.layerRunners.values()) {
      runner.stop();
    }
    this.layerRunners.clear();
    this.layerAtMap.clear();
    for (const layerName of ["master", "screens", "transient"]) {
      const container = this.getLayerContainer(layerName);
      container.pivot.set(0, 0);
      container.position.set(0, 0);
      container.scale.set(1);
      container.angle = 0;
      container.alpha = 1;
      container.blendMode = "normal";
    }
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
    const isCharacter = CHARACTER_TAGS.has(saved.tag);
    const bounds = node.getLocalBounds();
    const baseWidth =
      bounds.width > 0 ? bounds.width : isCharacter ? 960 : LOGICAL_WIDTH;
    const baseHeight =
      bounds.height > 0 ? bounds.height : isCharacter ? 960 : LOGICAL_HEIGHT;

    const initialState: Partial<AtlState> = saved.isTopLeftOverlay
      ? {
          xpos: saved.x,
          xposRel: false,
          ypos: saved.y,
          yposRel: false,
          xanchor: 0,
          xanchorRel: false,
          yanchor: 0,
          yanchorRel: false,
          xoffset: saved.xoffset,
          yoffset: saved.yoffset,
          zoom: saved.zoom,
          alpha: saved.alpha,
        }
      : {
          xpos: saved.xcenter,
          xposRel: false,
          xanchor: 0.5,
          xanchorRel: true,
          ypos: saved.ypos,
          yposRel: false,
          yanchor: saved.yanchor,
          yanchorRel: true,
          xoffset: saved.xoffset,
          yoffset: saved.yoffset,
          zoom: saved.zoom,
          alpha: saved.alpha,
        };

    const runner = new AtlRunner(node, this.createAtlContext(true), initialState, {
      width: baseWidth,
      height: baseHeight,
    });
    node.zIndex = saved.zorder;
    layerContainer.sortableChildren = true;
    layerContainer.addChild(node);
    syncStateToNode(
      node,
      node.children[0] as Container,
      runner.state,
      baseWidth,
      baseHeight,
    );

    const record: ShownSprite = {
      tag: saved.tag,
      imageName: saved.imageName,
      layerName: saved.layerName,
      atTransforms: [...saved.at],
      isTopLeftOverlay: saved.isTopLeftOverlay,
      node,
      baseWidth,
      baseHeight,
      zorder: saved.zorder,
      runner,
      hiding: false,
    };
    this.sprites.set(saved.tag, record);

    const continuous = saved.at.filter((name) => {
      const base = name.trim().split("(")[0];
      return (
        base === "panic" ||
        base === "n_cg2_wiggle_loop" ||
        base === "vignetteflicker" ||
        base.startsWith("credits_")
      );
    });
    if (continuous.length > 0) {
      runner.start(this.atNamesToSteps(continuous), "replace");
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
    this.captureOldFrameIfNeeded();

    for (const sp of this.sprites.values()) {
      sp.runner.stop();
    }
    this.sprites.clear();
    this.currentBgRunner?.stop();
    this.currentBgRunner = null;
    for (const child of this.stage.layers.master.removeChildren()) {
      child.destroy({ children: true });
    }
    for (const child of this.stage.layers.transient.removeChildren()) {
      child.destroy({ children: true });
    }
    for (const child of this.stage.layers.background.removeChildren()) {
      child.destroy({ children: true });
    }

    this.currentBgName = imageName;
    this.currentBgAt = [...(options?.at ?? [])];
    const node = await this.assets.buildDisplayable(imageName, {
      evalAst: this.evalAstFn,
      ticker: this.stage.app.ticker,
      paramText: options?.paramText,
    });
    const bounds = node.getLocalBounds();
    const baseW = bounds.width > 0 ? bounds.width : LOGICAL_WIDTH;
    const baseH = bounds.height > 0 ? bounds.height : LOGICAL_HEIGHT;
    this.stage.layers.background.addChild(node);
    this.currentBgNode = node;

    const steps: AtlStatement[] = [
      ...this.atNamesToSteps(options?.at ?? []),
      ...(options?.atl ?? []),
    ];
    if (steps.length > 0) {
      this.currentBgRunner = new AtlRunner(
        node,
        this.createAtlContext(true),
        undefined,
        { width: baseW, height: baseH },
      );
      this.currentBgRunner.start(steps, "show");
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
    this.captureOldFrameIfNeeded();

    const trimmed = imageNameOrTag.trim();
    const parts = trimmed.split(/\s+/);
    const tag = options?.tag || parts[0] || trimmed;
    const existing = this.sprites.get(tag);
    const layerName = options?.layer || existing?.layerName || "master";
    const layerContainer = this.getLayerContainer(layerName);

    const isTagOnly =
      !options?.def &&
      !options?.paramText &&
      parts.length === 1 &&
      !this.assets.hasImageDef(trimmed) &&
      !this.assets.resolveGamePath(trimmed) &&
      existing !== undefined;

    const isHideTransform = atTransforms.some((raw) => {
      const base = raw.trim().split("(")[0];
      return base === "thide" || base === "lhide";
    });

    let node: Container;
    let resolvedImageName = trimmed;
    const prevState: Partial<AtlState> | undefined = existing
      ? { ...existing.runner.state }
      : undefined;

    if (isTagOnly && existing) {
      node = existing.node;
      resolvedImageName = existing.imageName;
      existing.hiding = false;
      if (existing.layerName !== layerName) {
        this.getLayerContainer(existing.layerName).removeChild(node);
        layerContainer.addChild(node);
      }
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
        existing.runner.stop();
        this.getLayerContainer(existing.layerName).removeChild(existing.node);
        existing.node.destroy({ children: true });
      }
      layerContainer.addChild(node);
    }

    const isCharacter = CHARACTER_TAGS.has(tag);
    const bounds = node.getLocalBounds();
    const baseWidth =
      bounds.width > 0 ? bounds.width : isCharacter ? 960 : LOGICAL_WIDTH;
    const baseHeight =
      bounds.height > 0 ? bounds.height : isCharacter ? 960 : LOGICAL_HEIGHT;

    const hasExplicitTransform =
      atTransforms.length > 0 || Boolean(options?.atl && options.atl.length > 0);
    const isTopLeftOverlay =
      !isCharacter &&
      !hasExplicitTransform &&
      !existing &&
      !trimmed.startsWith("credits_") &&
      !trimmed.startsWith("poem_");

    let startState: Partial<AtlState>;
    if (prevState) {
      startState = prevState;
    } else if (isCharacter && !hasExplicitTransform) {
      startState = {
        xpos: LOGICAL_WIDTH / 2,
        xposRel: false,
        xanchor: 0.5,
        xanchorRel: true,
        ypos: 1.03,
        yposRel: true,
        yanchor: 1.0,
        yanchorRel: true,
        zoom: CHARACTER_BASE_SCALE,
        alpha: 1,
      };
    } else {
      startState = createDefaultAtlState();
    }

    const runner =
      isTagOnly && existing
        ? existing.runner
        : new AtlRunner(node, this.createAtlContext(true), startState, {
            width: baseWidth,
            height: baseHeight,
          });

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
      zorder,
      runner,
      hiding: isHideTransform,
    };
    this.sprites.set(tag, record);

    const steps: AtlStatement[] = [
      ...this.atNamesToSteps(atTransforms),
      ...(options?.atl ?? []),
    ];
    const eventName: AtlEventName = isHideTransform
      ? "hide"
      : existing
        ? "replace"
        : "show";

    if (steps.length > 0) {
      runner.start(steps, eventName, {}, () => {
        if (record.hiding && this.sprites.get(tag) === record) {
          this.sprites.delete(tag);
          if (node.parent === layerContainer) {
            layerContainer.removeChild(node);
          }
          node.destroy({ children: true });
        }
      });
    } else if (prevState) {
      syncStateToNode(
        node,
        (node.children[0] as Container) ?? node,
        runner.state,
        baseWidth,
        baseHeight,
      );
    } else if (isCharacter && !hasExplicitTransform) {
      syncStateToNode(
        node,
        (node.children[0] as Container) ?? node,
        runner.state,
        baseWidth,
        baseHeight,
      );
    }
  }

  public showLayer(
    layerName: string,
    atTransforms: string[] = [],
    atl?: AtlStatement[],
  ): void {
    this.captureOldFrameIfNeeded();

    const prev = this.layerRunners.get(layerName);
    if (prev) {
      prev.stop();
      this.layerRunners.delete(layerName);
    }

    if (atTransforms.length === 0) {
      this.layerAtMap.delete(layerName);
    } else {
      this.layerAtMap.set(layerName, [...atTransforms]);
    }

    const container = this.getLayerContainer(layerName);
    container.pivot.set(0, 0);
    container.position.set(0, 0);
    container.scale.set(1);
    container.angle = 0;
    container.alpha = 1;
    container.blendMode = "normal";

    const steps: AtlStatement[] = [
      ...this.atNamesToSteps(atTransforms),
      ...(atl ?? []),
    ];
    if (steps.length === 0) {
      return;
    }

    const runner = new AtlRunner(
      container,
      this.createAtlContext(false),
      createDefaultAtlState(),
      { width: LOGICAL_WIDTH, height: LOGICAL_HEIGHT },
    );
    this.layerRunners.set(layerName, runner);
    runner.start(steps, "show");
  }

  public async hide(tagOrName: string): Promise<void> {
    const tag = tagOrName.split(/\s+/)[0] || tagOrName;
    const existing = this.sprites.get(tag);
    if (!existing) {
      return;
    }
    if (existing.hiding) {
      // Let active `thide`/`lhide` animation complete naturally in background
      return;
    }
    this.captureOldFrameIfNeeded();
    existing.runner.stop();
    this.sprites.delete(tag);
    this.getLayerContainer(existing.layerName).removeChild(existing.node);
    existing.node.destroy({ children: true });
  }

  public async runTransition(expr: string | null, resolvedMs?: number): Promise<void> {
    if (!expr || expr === "None") {
      this.markTransitionCheckpoint();
      return;
    }

    const oldTex = this.pendingOldFrameTex;
    this.pendingOldFrameTex = null;

    const lower = expr.toLowerCase();

    if (lower === "wipeleft") {
      await this.imageDissolveTransition("images/menu/wipeleft.png", 500, 64, oldTex);
      return;
    }

    if (lower === "wipeleft_scene") {
      await this.curtainWipeScene("images/menu/wipeleft.png", 500, 250, 64, oldTex);
      return;
    }

    if (lower.includes("imagedissolve")) {
      const m = /ImageDissolve\("([^"]+)"\s*,\s*([0-9.]+)(?:.*ramplen=([0-9]+))?/i.exec(
        expr,
      );
      if (m) {
        const ramplen = m[3] ? parseInt(m[3], 10) : 8;
        await this.imageDissolveTransition(
          m[1],
          parseFloat(m[2]) * 1000,
          ramplen,
          oldTex,
        );
        return;
      }
    }

    if (lower === "dissolve_scene_full") {
      await this.fadeBlackCurtain(1000, 1000, 1000, oldTex);
      return;
    }

    if (lower === "dissolve_scene_half") {
      oldTex?.destroy(true);
      await this.fadeBlackCurtain(0, 1000, 1000, null);
      return;
    }

    if (lower === "close_eyes") {
      await this.fadeBlackCurtain(500, 250, 0, oldTex);
      return;
    }

    if (lower === "open_eyes") {
      await this.dissolveTransition(500, oldTex);
      return;
    }

    if (lower === "trueblack") {
      oldTex?.destroy(true);
      await this.pauseMs(250);
      return;
    }

    if (lower === "tpause") {
      oldTex?.destroy(true);
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

    await this.dissolveTransition(
      Math.max(40, Math.min(durationMs, 3000)),
      oldTex,
    );
  }

  private async dissolveTransition(
    durationMs: number,
    oldTex: RenderTexture | null,
  ): Promise<void> {
    if (oldTex) {
      const oldSprite = new Sprite(oldTex);
      this.stage.layers.overlay.addChild(oldSprite);
      await this.tween(durationMs, (p) => {
        oldSprite.alpha = 1 - p;
      });
      this.stage.layers.overlay.removeChild(oldSprite);
      oldSprite.destroy();
      oldTex.destroy(true);
      return;
    }

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
    ramplen: number,
    oldTex: RenderTexture | null,
  ): Promise<void> {
    const tex = await this.assets.loadTexture(maskPath);
    const rampFrac = ramplen / 256.0;

    if (oldTex) {
      const oldSprite = new Sprite(oldTex);
      const filter = new ImageDissolveFilter(tex, rampFrac, true);
      filter.progress = 1;
      oldSprite.filters = [filter];
      this.stage.layers.overlay.addChild(oldSprite);
      await this.tween(durationMs, (p) => {
        filter.progress = 1 - p;
      });
      this.stage.layers.overlay.removeChild(oldSprite);
      oldSprite.destroy();
      oldTex.destroy(true);
      return;
    }

    const filter = new ImageDissolveFilter(tex, rampFrac, false);
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
    ramplen: number,
    oldTex: RenderTexture | null,
  ): Promise<void> {
    const tex = await this.assets.loadTexture(maskPath);
    const rampFrac = ramplen / 256.0;

    let oldSprite: Sprite | null = null;
    if (oldTex) {
      oldSprite = new Sprite(oldTex);
      this.stage.layers.overlay.addChild(oldSprite);
    }

    const curtain = new Graphics();
    curtain.rect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
    curtain.fill({ color: 0x000000, alpha: 1 });
    const filterIn = new ImageDissolveFilter(tex, rampFrac, false);
    curtain.filters = [filterIn];
    this.stage.layers.overlay.addChild(curtain);

    await this.tween(wipeMs, (p) => {
      filterIn.progress = p;
    });

    if (oldSprite) {
      this.stage.layers.overlay.removeChild(oldSprite);
      oldSprite.destroy();
      oldTex?.destroy(true);
    }

    if (holdMs > 0) {
      curtain.filters = [];
      await this.pauseMs(holdMs);
    }

    const filterOut = new ImageDissolveFilter(tex, rampFrac, true);
    filterOut.progress = 1;
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
    oldTex: RenderTexture | null,
  ): Promise<void> {
    let oldSprite: Sprite | null = null;
    if (oldTex && inMs > 0) {
      oldSprite = new Sprite(oldTex);
      this.stage.layers.overlay.addChild(oldSprite);
    } else {
      oldTex?.destroy(true);
    }

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
    if (oldSprite) {
      this.stage.layers.overlay.removeChild(oldSprite);
      oldSprite.destroy();
      oldTex?.destroy(true);
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

  private atNamesToSteps(atTransforms: string[]): AtlStatement[] {
    return atTransforms.map((raw) => ({
      type: "step",
      expressions: [{ expr: raw.trim(), with: null }],
    }));
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
