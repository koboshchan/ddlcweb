import {
  Assets,
  ColorMatrixFilter,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Text,
  TextStyle,
  Texture,
  Ticker,
  TilingSprite,
} from "pixi.js";
import type {
  AtlStatement,
  GameManifest,
  ImageDef,
  PyExprNode,
  TransformDef,
} from "../types/game-data";
import { AtlRunner, evaluateAtlNumber } from "./AtlRunner";
import { AnimatedMaskFilter, createBloodEmitter } from "./SpecialEffects";
import {
  bindTickerToContainer,
  LOGICAL_HEIGHT,
  LOGICAL_WIDTH,
} from "./Stage";

const GAME_ASSETS_BASE = "./game-assets/game/";

export interface DisplayableBuildContext {
  evalAst?: (node: PyExprNode | null | undefined) => unknown;
  ticker?: Ticker;
  paramText?: string;
}

/**
 * Resolves Ren'Py paths and symbolic image definitions into live PixiJS v8
 * textures, GPU-composited DisplayObjects, procedural shaders, and text sprites.
 */
export class AssetLoader {
  private readonly fileSet: Set<string>;
  private readonly lowerFileMap = new Map<string, string>();
  private readonly imageDefs: Record<string, ImageDef>;
  private readonly textureCache = new Map<string, Texture>();
  private fontsLoaded = false;
  private transformDefs: Record<string, TransformDef> = {};
  private evalExprFn?: (expr: string) => number;

  public constructor(
    private readonly manifest: GameManifest,
    imageDefs: Record<string, ImageDef>,
  ) {
    this.fileSet = new Set(manifest.gameFiles);
    for (const f of manifest.gameFiles) {
      this.lowerFileMap.set(f.toLowerCase(), f);
    }
    this.imageDefs = imageDefs;
  }

  public setAtlConfig(
    transformDefs: Record<string, TransformDef>,
    evalExpr?: (expr: string) => number,
  ): void {
    this.transformDefs = transformDefs;
    this.evalExprFn = evalExpr;
  }

  public resolveGamePath(rawPath: string): string | null {
    const cleaned = rawPath.replace(/^\/+/, "");
    if (this.fileSet.has(cleaned)) {
      return cleaned;
    }
    const underImages = `images/${cleaned}`;
    if (this.fileSet.has(underImages)) {
      return underImages;
    }
    const ci = this.lowerFileMap.get(cleaned.toLowerCase());
    if (ci) {
      return ci;
    }
    const ciImages = this.lowerFileMap.get(underImages.toLowerCase());
    if (ciImages) {
      return ciImages;
    }
    return null;
  }

  public getAssetUrl(rawPath: string): string {
    const resolved =
      this.resolveGamePath(rawPath) ?? rawPath.replace(/^\/+/, "");
    const encoded = resolved
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return `${GAME_ASSETS_BASE}${encoded}`;
  }

  public async loadFonts(): Promise<void> {
    if (this.fontsLoaded) {
      return;
    }
    const tasks: Promise<void>[] = [];
    for (const font of this.manifest.fonts) {
      const url = this.getAssetUrl(font.file);
      const face = new FontFace(font.family, `url("${url}")`);
      const loadTask = face
        .load()
        .then((loaded) => {
          document.fonts.add(loaded);
        })
        .catch((err) => {
          console.warn(
            `[AssetLoader] Failed to load font ${font.family}:`,
            err,
          );
        });
      tasks.push(loadTask);
    }
    await Promise.all(tasks);
    this.fontsLoaded = true;
  }

  public async loadTexture(rawPath: string): Promise<Texture> {
    const resolved = this.resolveGamePath(rawPath);
    if (!resolved) {
      console.warn(`[AssetLoader] Missing texture path: ${rawPath}`);
      return Texture.EMPTY;
    }
    const cached = this.textureCache.get(resolved);
    if (cached) {
      return cached;
    }
    const url = this.getAssetUrl(resolved);
    const texture = (await Assets.load<Texture>(url)) ?? Texture.EMPTY;
    this.textureCache.set(resolved, texture);
    return texture;
  }

  public getImageDef(name: string): ImageDef | undefined {
    return this.imageDefs[name];
  }

  public hasImageDef(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.imageDefs, name);
  }

  public async buildDisplayable(
    nameOrPath: string,
    ctx: DisplayableBuildContext = {},
  ): Promise<Container> {
    // Handle special procedural DDLC displayables
    if (nameOrPath === "blood" && ctx.ticker) {
      return createBloodEmitter(this, ctx.ticker, {
        dripChance: 0.05,
        burstSize: 100,
        numSquirts: 4,
      });
    }
    if (nameOrPath === "blood_eye" && ctx.ticker) {
      return createBloodEmitter(this, ctx.ticker, {
        dripChance: 0.5,
        burstSize: 100,
        numSquirts: 0,
      });
    }
    if (nameOrPath === "blood_eye2" && ctx.ticker) {
      return createBloodEmitter(this, ctx.ticker, {
        dripChance: 0.005,
        burstSize: 0,
        numSquirts: 0,
      });
    }

    if (/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(nameOrPath)) {
      return this.buildFromDef({ kind: "color", hex: nameOrPath }, ctx, nameOrPath);
    }

    const def = this.imageDefs[nameOrPath];
    if (def) {
      return this.buildFromDef(def, ctx, nameOrPath);
    }

    const directPath = this.resolveGamePath(nameOrPath);
    if (directPath) {
      const texture = await this.loadTexture(directPath);
      const container = new Container();
      container.addChild(new Sprite(texture));
      return container;
    }

    console.warn(`[AssetLoader] Unknown image displayable: ${nameOrPath}`);
    return new Container();
  }

  public async buildFromDef(
    def: ImageDef,
    ctx: DisplayableBuildContext = {},
    nameHint = "",
  ): Promise<Container> {
    switch (def.kind) {
      case "color": {
        const container = new Container();
        const { color, alpha } = parseHexColor(def.hex);
        const rect = new Graphics();
        rect.rect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
        rect.fill({ color, alpha });
        container.addChild(rect);
        return container;
      }

      case "file": {
        if (!this.resolveGamePath(def.path) && this.imageDefs[def.path]) {
          return this.buildFromDef(this.imageDefs[def.path], ctx, def.path);
        }
        const texture = await this.loadTexture(def.path);
        const container = new Container();
        container.addChild(new Sprite(texture));
        return container;
      }

      case "composite": {
        const container = new Container();
        const layerNodes = await Promise.all(
          def.layers.map(async (layer) => {
            const child = await this.buildFromDef(layer.image, ctx);
            child.position.set(layer.x, layer.y);
            return child;
          }),
        );
        for (const node of layerNodes) {
          container.addChild(node);
        }
        return container;
      }

      case "tile": {
        if (def.child.kind === "file") {
          const texture = await this.loadTexture(def.child.path);
          const container = new Container();
          const tile = new TilingSprite({
            texture,
            width: LOGICAL_WIDTH,
            height: LOGICAL_HEIGHT,
          });
          container.addChild(tile);
          return container;
        }
        return this.buildFromDef(def.child, ctx);
      }

      case "flip": {
        const child = await this.buildFromDef(def.child, ctx);
        const bounds = child.getLocalBounds();
        if (def.horizontal) {
          child.scale.x *= -1;
          child.position.x += bounds.width;
        }
        if (def.vertical) {
          child.scale.y *= -1;
          child.position.y += bounds.height;
        }
        const wrapper = new Container();
        wrapper.addChild(child);
        return wrapper;
      }

      case "crop": {
        if (def.child.kind === "file") {
          const base = await this.loadTexture(def.child.path);
          const [x, y, w, h] = def.rect;
          const cropped = new Texture({
            source: base.source,
            frame: new Rectangle(x, y, w, h),
          });
          const container = new Container();
          container.addChild(new Sprite(cropped));
          return container;
        }
        return this.buildFromDef(def.child, ctx);
      }

      case "scale": {
        const child = await this.buildFromDef(def.child, ctx);
        child.scale.set(def.factor);
        const wrapper = new Container();
        wrapper.addChild(child);
        return wrapper;
      }

      case "alpha": {
        const child = await this.buildFromDef(def.child, ctx);
        child.alpha = def.alpha;
        const wrapper = new Container();
        wrapper.addChild(child);
        return wrapper;
      }

      case "matrixColor": {
        const child = await this.buildFromDef(def.child, ctx);
        const cm = new ColorMatrixFilter();
        if (def.matrix.includes("SaturationMatrix(0")) {
          cm.desaturate();
        } else if (def.matrix.includes("InvertMatrix")) {
          cm.negative(false);
        }
        child.filters = [cm];
        return child;
      }

      case "conditionSwitch": {
        const findMatchIdx = (): number => {
          for (let i = 0; i < def.branches.length; i++) {
            const br = def.branches[i];
            const matched = ctx.evalAst
              ? Boolean(ctx.evalAst(br.condAst))
              : br.condition === "True";
            if (matched) {
              return i;
            }
          }
          return -1;
        };

        const container = new Container({
          label: `cond-switch:${nameHint || "anon"}`,
        });
        let activeIdx = findMatchIdx();
        if (activeIdx >= 0) {
          const initialChild = await this.buildFromDef(
            def.branches[activeIdx].image,
            ctx,
          );
          container.addChild(initialChild);
        }

        if (ctx.ticker && ctx.evalAst && def.branches.length > 1) {
          let switching = false;
          bindTickerToContainer(container, ctx.ticker, () => {
            if (switching) {
              return;
            }
            const nextIdx = findMatchIdx();
            if (nextIdx >= 0 && nextIdx !== activeIdx) {
              switching = true;
              void this.buildFromDef(def.branches[nextIdx].image, ctx)
                .then((nextNode) => {
                  if (container.destroyed) {
                    nextNode.destroy({ children: true });
                    return;
                  }
                  for (const old of container.removeChildren()) {
                    old.destroy({ children: true });
                  }
                  container.addChild(nextNode);
                  activeIdx = nextIdx;
                })
                .finally(() => {
                  switching = false;
                });
            }
          });
        }

        return container;
      }

      case "animatedMask": {
        const child = await this.buildFromDef(def.child, ctx);
        const resolveMaskPath = (tag: string): string => {
          const imgDef = this.imageDefs[tag];
          if (imgDef?.kind === "file") {
            return imgDef.path;
          }
          if (imgDef?.kind === "atl" && imgDef.preview?.kind === "file") {
            return imgDef.preview.path;
          }
          return tag;
        };
        const maskPath = resolveMaskPath(def.mask);
        const maskBPath = resolveMaskPath(def.maskb);

        const [maskTex, maskBTex] = await Promise.all([
          this.loadTexture(maskPath),
          this.loadTexture(maskBPath),
        ]);
        const filter = new AnimatedMaskFilter(
          maskTex,
          maskBTex,
          def.op,
          def.moving,
        );
        child.filters = [filter];
        if (ctx.ticker) {
          let st = 0;
          bindTickerToContainer(child, ctx.ticker, (t: Ticker) => {
            st += t.deltaMS / 1000;
            filter.update(st, def.oc, def.speed, def.frequency, def.amount);
          });
        }
        return child;
      }

      case "text": {
        return this.buildTextDisplayable(
          def.text ?? ctx.paramText ?? "",
          nameHint,
          def.props,
        );
      }

      case "atl": {
        const outer = new Container({ label: `atl:${nameHint || "anon"}` });
        const inner = new Container({ label: `atl-inner:${nameHint || "anon"}` });
        outer.addChild(inner);
        if (def.preview) {
          const previewNode = await this.buildFromDef(def.preview, ctx);
          inner.addChild(previewNode);
        }
        const initialSize = extractInitialAtlSize(def.steps);
        const rawBounds = inner.getLocalBounds();
        const baseW = rawBounds.width > 0 ? rawBounds.width : LOGICAL_WIDTH;
        const baseH = rawBounds.height > 0 ? rawBounds.height : LOGICAL_HEIGHT;
        if (initialSize && rawBounds.width > 0 && rawBounds.height > 0) {
          inner.scale.set(initialSize[0] / baseW, initialSize[1] / baseH);
        }
        if (ctx.ticker && def.steps.length > 0) {
          const runner = new AtlRunner(
            inner,
            {
              assets: this,
              ticker: ctx.ticker,
              transformDefs: this.transformDefs,
              evalExpr: (expr, locals) =>
                evaluateAtlNumber(expr, locals, this.evalExprFn),
            },
            initialSize ? { size: initialSize } : undefined,
            {
              width: baseW,
              height: baseH,
            },
          );
          runner.start(def.steps, "show");
        }
        return outer;
      }

      default: {
        return new Container();
      }
    }
  }

  private buildTextDisplayable(
    textValue: string,
    nameHint: string,
    props: Record<string, unknown>,
  ): Container {
    const container = new Container();
    const isConsole = nameHint.startsWith("console_");
    const isCredits =
      nameHint.startsWith("credits_") || nameHint === "monika_credits_text";

    let fontFamily = "Aller_Rg";
    let fontSize = 24;
    let fill = "#ffffff";
    let strokeColor = "#000000";
    let strokeWidth = 0;
    let align: "left" | "center" | "right" = "left";
    let xpos = typeof props.xpos === "number" ? props.xpos : 0;
    let ypos = typeof props.ypos === "number" ? props.ypos : 0;

    if (isConsole) {
      fontFamily = "F25_Bank_Printer";
      fontSize = 18;
      fill = "#ffffff";
      if (nameHint === "console_caret") {
        xpos = 5;
        ypos = 10;
      } else if (nameHint === "console_text") {
        xpos = 30;
        ypos = 10;
      } else if (nameHint === "console_history") {
        xpos = 30;
        ypos = 50;
      }
    } else if (nameHint === "credits_header") {
      fontFamily = "RifficFree-Bold";
      fontSize = 36;
      fill = "#ffaae6";
      strokeWidth = 0;
      align = "center";
      ypos = -40;
    } else if (nameHint === "credits_text") {
      fontFamily = "Halogen";
      fontSize = 36;
      fill = "#ffffff";
      strokeWidth = 0;
      align = "center";
      ypos = 40;
    } else if (nameHint === "monika_credits_text") {
      fontFamily = "m1";
      fontSize = 40;
      fill = "#ffffff";
      strokeWidth = 0;
      align = "center";
    } else if (nameHint === "splash_warning") {
      fontFamily = "Aller_Rg";
      fontSize = 24;
      fill = "#000000";
      align = "center";
      xpos = LOGICAL_WIDTH / 2;
      ypos = LOGICAL_HEIGHT / 2;
    } else if (nameHint.startsWith("fake_exception")) {
      fontFamily = "Vera";
      fontSize = typeof props.size === "number" ? props.size : 28;
      fill = "#000000";
    }

    const style = new TextStyle({
      fontFamily,
      fontSize,
      fill,
      align,
      stroke: strokeWidth > 0 ? { color: strokeColor, width: strokeWidth } : undefined,
      wordWrap: isCredits || isConsole,
      wordWrapWidth: isConsole ? 560 : 720,
    });

    const txt = new Text({ text: textValue, style });
    if (
      align === "center" &&
      nameHint !== "credits_header" &&
      nameHint !== "credits_text"
    ) {
      txt.anchor.set(0.5, 0.5);
    }
    txt.position.set(xpos, ypos);
    container.addChild(txt);
    return container;
  }
}

function extractInitialAtlSize(
  steps: AtlStatement[],
): [number, number] | null {
  for (const s of steps) {
    if (s.type !== "step") {
      break;
    }
    const step = s as Extract<AtlStatement, { type: "step" }>;
    if (step.duration || step.warper) {
      break;
    }
    if (step.properties) {
      for (const [k, v] of step.properties) {
        if (k === "size") {
          const m = /^\(\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*([0-9]+(?:\.[0-9]+)?)\s*\)$/.exec(v.trim());
          if (m) {
            return [parseFloat(m[1]), parseFloat(m[2])];
          }
        }
      }
    }
  }
  return null;
}

export function parseHexColor(hex: string): { color: number; alpha: number } {
  const clean = hex.replace(/^#/, "");
  if (clean.length === 3) {
    const r = clean[0] + clean[0];
    const g = clean[1] + clean[1];
    const b = clean[2] + clean[2];
    return {
      color: parseInt(`${r}${g}${b}`, 16),
      alpha: 1,
    };
  }
  if (clean.length === 6) {
    return {
      color: parseInt(clean, 16),
      alpha: 1,
    };
  }
  if (clean.length === 8) {
    const rgb = parseInt(clean.slice(0, 6), 16);
    const a = parseInt(clean.slice(6, 8), 16) / 255;
    return {
      color: rgb,
      alpha: a,
    };
  }
  return {
    color: 0x000000,
    alpha: 1,
  };
}
