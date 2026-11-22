import {
  Container,
  Filter,
  GlProgram,
  Graphics,
  Rectangle,
  RenderTexture,
  Sprite,
  Texture,
  Ticker,
} from "pixi.js";
import type { AssetLoader } from "./AssetLoader";
import type { AudioEngine } from "./AudioEngine";
import {
  bindTickerToContainer,
  LOGICAL_HEIGHT,
  LOGICAL_WIDTH,
  type Stage,
} from "./Stage";

const INVERT_VERTEX = `
in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition(void) {
  vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  return vec4(position, 0.0, 1.0);
}

vec2 filterTextureCoord(void) {
  return aPosition * (uOutputFrame.zw * uInputSize.zw);
}

void main(void) {
  gl_Position = filterVertexPosition();
  vTextureCoord = filterTextureCoord();
}
`;

const INVERT_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;

void main(void) {
  vec4 src = texture(uTexture, vTextureCoord);
  finalColor = vec4(vec3(src.a) - src.rgb, src.a);
}
`;

const ANIMATED_MASK_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uMask;
uniform sampler2D uMaskB;
uniform float uThreshold;
uniform float uRamp;
uniform float uMaskOffsetX;
uniform float uMoving;

void main(void) {
  vec4 src = texture(uTexture, vTextureCoord);
  vec2 uv1 = vTextureCoord;
  if (uMoving > 0.5) {
    uv1.x = fract(vTextureCoord.x + uMaskOffsetX);
  }
  float m1 = texture(uMask, uv1).a;
  float m2 = texture(uMaskB, vTextureCoord).a;
  float maskAlpha = clamp(m2 + m1 * (1.0 - m2), 0.0, 1.0);
  float ramp = max(uRamp / 256.0, 0.004);
  float alpha = clamp((uThreshold * (1.0 + ramp) + maskAlpha - 1.0) / ramp, 0.0, 1.0);
  finalColor = src * alpha;
}
`;

export class InvertColorFilter extends Filter {
  public constructor() {
    super({
      glProgram: new GlProgram({
        vertex: INVERT_VERTEX,
        fragment: INVERT_FRAGMENT,
        name: "ddlc-invert",
      }),
    });
  }
}

export class AnimatedMaskFilter extends Filter {
  public constructor(
    maskTex: Texture,
    maskBTex: Texture,
    op: number,
    moving: boolean,
  ) {
    super({
      glProgram: new GlProgram({
        vertex: INVERT_VERTEX,
        fragment: ANIMATED_MASK_FRAGMENT,
        name: "ddlc-animated-mask",
      }),
      resources: {
        uMask: maskTex.source,
        uMaskB: maskBTex.source,
        maskUniforms: {
          uThreshold: { value: 0.15, type: "f32" },
          uRamp: { value: op, type: "f32" },
          uMaskOffsetX: { value: 0, type: "f32" },
          uMoving: { value: moving ? 1 : 0, type: "f32" },
        },
      },
    });
  }

  public update(st: number, oc: number, speed: number, frequency: number, amount: number): void {
    const val =
      oc + Math.pow(Math.sin((st * speed) / 8), 64 * frequency) * amount;
    this.resources.maskUniforms.uniforms.uThreshold = val;
    this.resources.maskUniforms.uniforms.uMaskOffsetX = (st * 50) / LOGICAL_WIDTH;
  }
}

interface TearPiece {
  startY: number;
  endY: number;
  offTime: number;
  onTime: number;
  offsetMin: number;
  offsetMax: number;
  offset: number;
  sprite: Sprite;
}

/**
 * Real-time horizontal strip tear/glitch effect matching DDLC's `Tear` displayable
 * in `effects.rpy`.
 */
export class TearEffect {
  private readonly container = new Container({ label: "screen-tear" });
  private readonly pieces: TearPiece[] = [];
  private renderTex: RenderTexture | null = null;
  private tickFn: ((t: Ticker) => void) | null = null;
  private elapsed = 0;

  public constructor(private readonly stage: Stage) {}

  public show(
    numTears = 10,
    offtimeMult = 1.0,
    ontimeMult = 1.0,
    offsetMin = -10,
    offsetMax = 10,
  ): void {
    this.hide();

    this.renderTex = RenderTexture.create({
      width: LOGICAL_WIDTH,
      height: LOGICAL_HEIGHT,
    });
    this.stage.app.renderer.render({
      container: this.stage.app.stage,
      target: this.renderTex,
    });

    const tearpoints = [0, LOGICAL_HEIGHT];
    for (let i = 0; i < numTears; i++) {
      tearpoints.push(10 + Math.floor(Math.random() * (LOGICAL_HEIGHT - 20)));
    }
    tearpoints.sort((a, b) => a - b);

    const baseBg = new Sprite(this.renderTex);
    this.container.addChild(baseBg);

    for (let i = 0; i < tearpoints.length - 1; i++) {
      const startY = tearpoints[i];
      const endY = tearpoints[i + 1];
      const h = Math.max(1, endY - startY);
      const subTex = new Texture({
        source: this.renderTex.source,
        frame: new Rectangle(0, startY, LOGICAL_WIDTH, h),
      });
      const sprite = new Sprite(subTex);
      sprite.position.set(0, startY);
      this.container.addChild(sprite);

      this.pieces.push({
        startY,
        endY,
        offTime: (Math.random() * 0.2 + 0.2) * offtimeMult,
        onTime: (Math.random() * 0.2 + 0.2) * ontimeMult,
        offsetMin,
        offsetMax,
        offset: 0,
        sprite,
      });
    }

    this.stage.layers.overlay.addChild(this.container);
    this.elapsed = 0;

    const tick = (ticker: Ticker): void => {
      this.elapsed += ticker.deltaMS / 1000;
      for (const piece of this.pieces) {
        const cycle = piece.offTime + piece.onTime;
        const phase = cycle > 0 ? this.elapsed % cycle : 0;
        if (phase > piece.offTime && piece.offset === 0) {
          piece.offset =
            piece.offsetMin +
            Math.floor(Math.random() * (piece.offsetMax - piece.offsetMin + 1));
          piece.sprite.position.x = piece.offset;
        } else if (phase <= piece.offTime && piece.offset !== 0) {
          piece.offset = 0;
          piece.sprite.position.x = 0;
        }
      }
    };

    this.tickFn = tick;
    this.stage.app.ticker.add(tick);
  }

  public hide(): void {
    if (this.tickFn) {
      this.stage.app.ticker.remove(this.tickFn);
      this.tickFn = null;
    }
    this.pieces.length = 0;
    this.stage.layers.overlay.removeChild(this.container);
    this.container.removeChildren();
    if (this.renderTex) {
      this.renderTex.destroy(true);
      this.renderTex = null;
    }
  }
}

/**
 * Stage color inversion effect matching DDLC's `Invert` displayable in `effects.rpy`.
 */
export class InvertEffect {
  private sprite: Sprite | null = null;
  private renderTex: RenderTexture | null = null;
  private showTimerId: number | null = null;
  private hideTimerId: number | null = null;
  private audioRef: AudioEngine | null = null;

  public constructor(private readonly stage: Stage) {}

  public show(lengthSec = 0.15, delaySec = 0, audio?: AudioEngine): void {
    this.hide();
    this.audioRef = audio ?? null;

    const captureAndShow = (): void => {
      const overlayWasVisible = this.stage.layers.overlay.visible;
      this.stage.layers.overlay.visible = false;
      try {
        this.renderTex = RenderTexture.create({
          width: LOGICAL_WIDTH,
          height: LOGICAL_HEIGHT,
        });
        this.stage.app.renderer.render({
          container: this.stage.app.stage,
          target: this.renderTex,
        });
      } finally {
        this.stage.layers.overlay.visible = overlayWasVisible;
      }

      const sp = new Sprite(this.renderTex);
      sp.filters = [new InvertColorFilter()];
      sp.visible = true;
      this.sprite = sp;
      this.stage.layers.overlay.addChild(sp);

      if (this.audioRef) {
        void this.audioRef
          .play("sfx", "sfx/glitch1.ogg", { loop: false })
          .catch(() => {});
      }

      if (lengthSec > 0) {
        this.hideTimerId = window.setTimeout(() => {
          this.hide();
        }, lengthSec * 1000);
      }
    };

    if (delaySec > 0) {
      this.showTimerId = window.setTimeout(captureAndShow, delaySec * 1000);
    } else {
      captureAndShow();
    }
  }

  public hide(): void {
    if (this.showTimerId !== null) {
      window.clearTimeout(this.showTimerId);
      this.showTimerId = null;
    }
    if (this.hideTimerId !== null) {
      window.clearTimeout(this.hideTimerId);
      this.hideTimerId = null;
    }
    if (this.audioRef) {
      this.audioRef.stop("sfx", 0);
      this.audioRef = null;
    }
    if (this.sprite) {
      this.stage.layers.overlay.removeChild(this.sprite);
      this.sprite.destroy();
      this.sprite = null;
    }
    if (this.renderTex) {
      this.renderTex.destroy(true);
      this.renderTex = null;
    }
  }
}

interface BloodDrop {
  sprite: Sprite;
  vx: number;
  vy: number;
  age: number;
  life: number;
}

/**
 * Physics particle emitter matching DDLC's `Blood` displayable (`blood`, `blood_eye`, `blood_eye2`).
 */
export function createBloodEmitter(
  assets: AssetLoader,
  ticker: Ticker,
  options: {
    dripChance: number;
    burstSize: number;
    numSquirts: number;
  },
): Container {
  const container = new Container({ label: "blood-emitter" });
  container.position.set(LOGICAL_WIDTH / 2, LOGICAL_HEIGHT / 2);

  const drops: BloodDrop[] = [];
  const squirts: Array<{ vx: number; vy: number; end: number }> = [];
  let elapsed = 0;
  let accum = 0;
  const gravity = 800;
  const density = 120;

  void assets.loadTexture("gui/blood_drop.png").then((tex) => {
    if (container.destroyed) {
      return;
    }
    const spawnDrop = (vx: number, vy: number, x = 0, y = 0): void => {
      const sp = new Sprite(tex);
      sp.anchor.set(0.5);
      sp.scale.set(0.75);
      sp.alpha = 0.75;
      sp.position.set(x, y);
      container.addChild(sp);
      drops.push({
        sprite: sp,
        vx,
        vy,
        age: 0,
        life: 0.4 + Math.random() * 0.6,
      });
    };

    for (let i = 0; i < options.burstSize; i++) {
      spawnDrop(
        (Math.random() - 0.5) * 200 + 20,
        (Math.random() - 0.75) * 400 + 20,
      );
    }
    for (let i = 0; i < options.numSquirts; i++) {
      const angle = Math.random() * Math.PI * 2;
      squirts.push({
        vx: 400 * Math.cos(angle),
        vy: 400 * Math.sin(angle),
        end: 0.25,
      });
    }

    bindTickerToContainer(container, ticker, (t: Ticker) => {
      const dt = t.deltaMS / 1000;
      elapsed += dt;
      accum += dt * density;

      while (accum >= 1) {
        accum -= 1;
        if (elapsed < 180) {
          if (Math.random() >= 1 - options.dripChance) {
            spawnDrop(20, Math.random() * 120 + 20);
          }
          for (const sq of squirts) {
            if (elapsed <= sq.end) {
              spawnDrop(
                sq.vx + (Math.random() - 0.5) * 20,
                sq.vy + (Math.random() - 0.5) * 20,
                (Math.random() - 0.5) * 5,
                (Math.random() - 0.5) * 5,
              );
            }
          }
        }
      }

      for (let i = drops.length - 1; i >= 0; i--) {
        const d = drops[i];
        d.age += dt;
        if (d.age >= d.life) {
          container.removeChild(d.sprite);
          d.sprite.destroy();
          drops.splice(i, 1);
          continue;
        }
        d.sprite.position.x += d.vx * dt;
        d.sprite.position.y += d.vy * dt;
        d.vy += gravity * dt;
        d.sprite.scale.set(0.75 * (1 - d.age / d.life));
      }
    });
  });

  return container;
}

/**
 * Procedural glitch rectangle cluster matching DDLC's `RectCluster` displayable
 * (`n_cg1b`, `natsuki mouth`, `n_rects_ghost1..5`).
 */
export function createRectCluster(
  ticker: Ticker,
  numRects = 12,
  areaWidth = 30,
  areaHeight = 30,
): Container {
  const container = new Container({ label: "rect-cluster" });
  const boxes: Graphics[] = [];

  for (let i = 0; i < numRects; i++) {
    const g = new Graphics();
    g.rect(0, 0, 1, 1);
    g.fill({ color: 0x000000, alpha: 1 });
    container.addChild(g);
    boxes.push(g);
  }

  const randomize = (): void => {
    for (const g of boxes) {
      g.position.set(
        (Math.random() - 0.5) * areaWidth * 2,
        (Math.random() - 0.5) * areaHeight * 2,
      );
      g.scale.set(
        Math.max(1, (Math.random() * areaWidth) / 2),
        Math.max(1, (Math.random() * areaHeight) / 2),
      );
    }
  };
  randomize();

  bindTickerToContainer(container, ticker, () => {
    randomize();
  });

  return container;
}

/**
 * Procedural timed glitch rectangles matching DDLC's `RectStatic` displayable
 * (`m_rectstatic`, `m_rectstatic2`, `m_rectstatic3`).
 */
export function createRectStatic(
  ticker: Ticker,
  numRects = 12,
  rectWidth = 30,
  rectHeight = 30,
  spriteTex?: Texture,
): Container {
  const container = new Container({ label: "rect-static" });
  const items: Array<{ node: Container; nextAt: number }> = [];
  let elapsed = 0;

  for (let i = 0; i < numRects; i++) {
    let node: Container;
    if (spriteTex) {
      const sp = new Sprite(spriteTex);
      sp.width = rectWidth;
      sp.height = rectHeight;
      node = sp;
    } else {
      const g = new Graphics();
      g.rect(0, 0, rectWidth, rectHeight);
      g.fill({ color: 0x000000, alpha: 1 });
      node = g;
    }
    node.position.set(
      Math.floor(Math.random() * 41) * 32,
      Math.floor(Math.random() * 24) * 32,
    );
    container.addChild(node);
    items.push({
      node,
      nextAt: Math.random() * 0.4 + 0.1,
    });
  }

  bindTickerToContainer(container, ticker, (t: Ticker) => {
    elapsed += t.deltaMS / 1000;
    for (const item of items) {
      if (elapsed >= item.nextAt) {
        item.node.position.set(
          Math.floor(Math.random() * 41) * 32,
          Math.floor(Math.random() * 24) * 32,
        );
        item.nextAt = elapsed + Math.random() * 0.4 + 0.1;
      }
    }
  });

  return container;
}
