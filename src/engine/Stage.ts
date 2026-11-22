import { Application, Container, type Ticker } from "pixi.js";

export const LOGICAL_WIDTH = 1280;
export const LOGICAL_HEIGHT = 720;

/**
 * Attaches a Pixi ticker listener to `container` and automatically unregisters it
 * when `container` is destroyed or detached from the stage after being attached.
 */
export function bindTickerToContainer(
  container: Container,
  ticker: Ticker,
  fn: (t: Ticker) => void,
): void {
  if (container.destroyed) {
    return;
  }
  let wasAttached = Boolean(container.parent);
  let active = true;
  const cleanup = (): void => {
    if (!active) {
      return;
    }
    active = false;
    ticker.remove(onTick);
    container.off("destroyed", cleanup);
  };
  const onTick = (t: Ticker): void => {
    if (!active || container.destroyed) {
      cleanup();
      return;
    }
    if (container.parent) {
      wasAttached = true;
    } else if (wasAttached) {
      cleanup();
      return;
    }
    fn(t);
  };
  container.once("destroyed", cleanup);
  ticker.add(onTick);
}

export interface StageLayers {
  background: Container;
  master: Container;
  transient: Container;
  screens: Container;
  overlay: Container;
}

/**
 * Manages the 1280x720 PixiJS v8 WebGL/WebGPU canvas and its pixel-locked
 * DOM overlay container, maintaining exact 16:9 aspect-ratio scaling across
 * any browser viewport size and devicePixelRatio.
 */
export class Stage {
  public readonly app: Application;
  public readonly frameEl: HTMLElement;
  public readonly pixiRoot: HTMLElement;
  public readonly uiRoot: HTMLElement;
  public readonly layers: StageLayers;

  private resizeHandler: (() => void) | null = null;

  private constructor(
    app: Application,
    frameEl: HTMLElement,
    pixiRoot: HTMLElement,
    uiRoot: HTMLElement,
  ) {
    this.app = app;
    this.frameEl = frameEl;
    this.pixiRoot = pixiRoot;
    this.uiRoot = uiRoot;

    this.layers = {
      background: new Container({ label: "background" }),
      master: new Container({ label: "master" }),
      transient: new Container({ label: "transient" }),
      screens: new Container({ label: "screens" }),
      overlay: new Container({ label: "overlay" }),
    };

    this.app.stage.addChild(this.layers.background);
    this.app.stage.addChild(this.layers.master);
    this.app.stage.addChild(this.layers.transient);
    this.app.stage.addChild(this.layers.screens);
    this.app.stage.addChild(this.layers.overlay);
  }

  public static async create(): Promise<Stage> {
    const frameEl = document.getElementById("stage-frame");
    const pixiRoot = document.getElementById("pixi-root");
    const uiRoot = document.getElementById("ui-root");

    if (!frameEl || !pixiRoot || !uiRoot) {
      throw new Error("Missing #stage-frame, #pixi-root, or #ui-root in DOM.");
    }

    const app = new Application();
    await app.init({
      width: LOGICAL_WIDTH,
      height: LOGICAL_HEIGHT,
      backgroundColor: 0xffffff,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      preference: "webgl",
    });

    pixiRoot.innerHTML = "";
    pixiRoot.appendChild(app.canvas);

    const stage = new Stage(app, frameEl, pixiRoot, uiRoot);
    stage.bindResize();
    return stage;
  }

  private bindResize(): void {
    const updateScale = (): void => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const scaleX = vw / LOGICAL_WIDTH;
      const scaleY = vh / LOGICAL_HEIGHT;
      const scale = Math.min(scaleX, scaleY);
      this.frameEl.style.transform = `scale(${scale})`;
    };

    updateScale();
    this.resizeHandler = updateScale;
    window.addEventListener("resize", updateScale);
  }

  public clearSceneLayers(): void {
    for (const layer of [
      this.layers.background,
      this.layers.master,
      this.layers.transient,
    ]) {
      for (const child of layer.removeChildren()) {
        child.destroy({ children: true });
      }
    }
  }

  public captureThumbnailDataUrl(width = 256, height = 144): string {
    const sourceCanvas = this.app.renderer.extract.canvas({
      target: this.app.stage,
    });
    const thumb = document.createElement("canvas");
    thumb.width = width;
    thumb.height = height;
    const ctx = thumb.getContext("2d");
    if (ctx && sourceCanvas instanceof HTMLCanvasElement) {
      ctx.drawImage(sourceCanvas, 0, 0, width, height);
    }
    return thumb.toDataURL("image/jpeg", 0.85);
  }

  public destroy(): void {
    if (this.resizeHandler) {
      window.removeEventListener("resize", this.resizeHandler);
      this.resizeHandler = null;
    }
    this.app.destroy(true);
  }
}
