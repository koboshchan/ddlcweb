import {
  ColorMatrixFilter,
  Container,
  Graphics,
  Sprite,
  Ticker,
} from "pixi.js";
import type { AssetLoader } from "../engine/AssetLoader";
import type { AudioEngine } from "../engine/AudioEngine";
import type { Persistence } from "../engine/Persistence";
import {
  ease,
  ease_cubic,
  easein_bounce,
  easein_quint,
  easeout,
} from "../engine/warpers";
import { LOGICAL_HEIGHT, LOGICAL_WIDTH, type Stage } from "../engine/Stage";

interface CastMemberConfig {
  texturePath: string;
  xcenter: number;
  ycenter: number;
  z: number;
  z2: number;
}

interface ActiveParticle {
  sprite: Sprite;
  xSpeed: number;
  ySpeed: number;
  age: number;
  life: number;
}

export interface TitleScreenCallbacks {
  onNewGame: () => void;
  onLoadGame: () => void;
  onSettings: () => void;
  onAbout: () => void;
  onOpenVirtualFiles: () => void;
  onExitGhostMenu?: () => void;
}

/**
 * Near pixel-perfect recreation of DDLC's animated Main Menu across all states:
 *   - Act 1 (`playthrough === 0`)
 *   - Act 2 (`playthrough === 1 || 2` — Sayori replaced by glitch art)
 *   - Act 3 (`playthrough === 3` — Monika-only `menu_bg_m.png` + `m1.ogg`)
 *   - Act 4 (`playthrough === 4` — Monika removed)
 *   - Ghost Menu Easter Egg (`persistent.ghost_menu === true` — B&W ghost art + `ghostmenu.ogg`)
 */
export class TitleScreen {
  private readonly root = new Container({ label: "title-screen" });
  private navEl: HTMLElement | null = null;
  private tickFn: ((ticker: Ticker) => void) | null = null;
  private mounted = false;

  public constructor(
    private readonly stage: Stage,
    private readonly assets: AssetLoader,
    private readonly audio: AudioEngine,
    private readonly persistence: Persistence,
    private readonly callbacks: TitleScreenCallbacks,
  ) {}

  private buildCastConfig(pt: number, ghost: boolean): CastMemberConfig[] {
    if (ghost) {
      return [
        { texturePath: "gui/menu_art_y_ghost.png", xcenter: 600, ycenter: 335, z: 0.54, z2: 0.6 },
        { texturePath: "gui/menu_art_n_ghost.png", xcenter: 750, ycenter: 385, z: 0.58, z2: 0.58 },
        { texturePath: "gui/menu_art_s_ghost.png", xcenter: 510, ycenter: 500, z: 0.68, z2: 0.68 },
        { texturePath: "gui/menu_art_m_ghost.png", xcenter: 1000, ycenter: 640, z: 1.0, z2: 1.0 },
      ];
    }

    if (pt === 3) {
      return [
        { texturePath: "gui/menu_art_m.png", xcenter: 1000, ycenter: 640, z: 1.0, z2: 1.0 },
      ];
    }

    const list: CastMemberConfig[] = [
      { texturePath: "gui/menu_art_y.png", xcenter: 600, ycenter: 335, z: 0.54, z2: 0.6 },
      { texturePath: "gui/menu_art_n.png", xcenter: 750, ycenter: 385, z: 0.58, z2: 0.58 },
    ];

    if (pt === 1 || pt === 2) {
      list.push({
        texturePath: "gui/menu_art_s_break.png",
        xcenter: 470,
        ycenter: 600,
        z: 0.8,
        z2: 0.8,
      });
    } else {
      list.push({
        texturePath: "gui/menu_art_s.png",
        xcenter: 510,
        ycenter: 500,
        z: 0.68,
        z2: 0.68,
      });
    }

    if (pt !== 4) {
      list.push({
        texturePath: "gui/menu_art_m.png",
        xcenter: 1000,
        ycenter: 640,
        z: 1.0,
        z2: 1.0,
      });
    }

    return list;
  }

  public async show(): Promise<void> {
    if (this.mounted) {
      return;
    }
    this.mounted = true;
    this.root.removeChildren();

    const pt = Number(this.persistence.data.playthrough ?? 0);
    const ghost = Boolean(this.persistence.data.ghost_menu);
    const castConfig = this.buildCastConfig(pt, ghost);
    const bgPath = pt === 3 ? "gui/menu_bg_m.png" : "gui/menu_bg.png";

    const [bgTex, navTex, logoTex, particleTex, ...castTextures] =
      await Promise.all([
        this.assets.loadTexture(bgPath),
        this.assets.loadTexture("gui/overlay/main_menu.png"),
        this.assets.loadTexture("gui/logo.png"),
        this.assets.loadTexture("gui/menu_particle.png"),
        ...castConfig.map((cfg) => this.assets.loadTexture(cfg.texturePath)),
      ]);

    const bgSprite = new Sprite(bgTex);
    bgSprite.position.set(0, ghost ? -500 : 0);
    if (ghost) {
      const bw = new ColorMatrixFilter();
      bw.desaturate();
      bgSprite.filters = [bw];
    }
    this.root.addChild(bgSprite);

    const castSprites: Array<{ sprite: Sprite; cfg: CastMemberConfig }> = [];
    for (let i = 0; i < castConfig.length; i++) {
      const cfg = castConfig[i];
      const sprite = new Sprite(castTextures[i]);
      sprite.anchor.set(0.5, 0.5);
      sprite.scale.set(ghost ? cfg.z2 : cfg.z2 * 0.75);
      if (ghost) {
        sprite.position.set(cfg.xcenter, cfg.ycenter);
      } else {
        sprite.position.set(
          cfg.xcenter + (740 - cfg.xcenter) * cfg.z * 0.5,
          cfg.ycenter + 1200 * cfg.z,
        );
      }
      this.root.addChild(sprite);
      castSprites.push({ sprite, cfg });
    }

    const navSprite = new Sprite(navTex);
    navSprite.position.set(ghost ? 0 : -500, 0);
    if (ghost) {
      const bw = new ColorMatrixFilter();
      bw.desaturate();
      navSprite.filters = [bw];
    }
    this.root.addChild(navSprite);

    const particleLayer = new Container();
    particleLayer.position.set(224, 104);
    this.root.addChild(particleLayer);

    const particles: ActiveParticle[] = [];
    let particlesSpawned = ghost;

    const logoSprite = new Sprite(logoTex);
    logoSprite.anchor.set(0.5, 0.5);
    logoSprite.scale.set(0.6);
    logoSprite.position.set(240, ghost ? 120 : 120 - 300);
    if (ghost) {
      const bw = new ColorMatrixFilter();
      bw.desaturate();
      logoSprite.filters = [bw];
    }
    this.root.addChild(logoSprite);

    const whiteFlash = new Graphics();
    whiteFlash.rect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
    whiteFlash.fill({ color: 0xffffff, alpha: 1 });
    whiteFlash.alpha = ghost ? 0 : 1;
    this.root.addChild(whiteFlash);

    this.stage.layers.screens.addChild(this.root);
    this.mountNavigationDom(ghost);
    this.tryPlayTitleMusic(ghost);

    let elapsed = 0;
    const onTick = (ticker: Ticker): void => {
      const dt = ticker.deltaMS / 1000;
      elapsed += dt;

      const scrollPx = ((elapsed % 3.0) / 3.0) * -100;
      let bgBaseY = ghost ? -500 : 0;

      if (!ghost) {
        if (elapsed >= 0.65) {
          const bgProgress = Math.min(1, (elapsed - 0.65) / 2.5);
          bgBaseY = -500 * ease_cubic(bgProgress);
        }

        if (elapsed < 0.75) {
          whiteFlash.alpha = 1 - easeout(elapsed / 0.75);
        } else if (elapsed >= 2.481 && elapsed < 2.981) {
          const flashP = (elapsed - 2.481) / 0.5;
          whiteFlash.alpha = 0.4 * (1 - flashP);
        } else {
          whiteFlash.alpha = 0;
        }

        for (const item of castSprites) {
          const { sprite, cfg } = item;
          const startYOff = 1200 * cfg.z;
          const startXOff = (740 - cfg.xcenter) * cfg.z * 0.5;
          const startZoom = cfg.z2 * 0.75;

          const yP = Math.max(0, Math.min(1, (elapsed - 1.0) / 1.75));
          const zxP = Math.max(0, Math.min(1, (elapsed - 1.75) / 1.5));

          const curYOff = startYOff * (1 - ease(yP));
          const curXOff = startXOff * (1 - ease(zxP));
          const curZoom = startZoom + (cfg.z2 - startZoom) * ease(zxP);

          sprite.position.set(cfg.xcenter + curXOff, cfg.ycenter + curYOff);
          sprite.scale.set(curZoom);
        }

        if (elapsed >= 1.5) {
          const navP = Math.min(1, (elapsed - 1.5) / 1.0);
          navSprite.position.x = -500 * (1 - easein_quint(navP));
        }

        if (elapsed >= 1.925) {
          const logoP = Math.min(1, (elapsed - 1.925) / 1.5);
          logoSprite.position.y = 120 - 300 * (1 - easein_bounce(logoP));
        }

        if (!particlesSpawned && elapsed >= 2.481) {
          particlesSpawned = true;
          for (let i = 0; i < 40; i++) {
            const speed = Math.random();
            const angle = Math.random() * Math.PI * 2;
            const xSpeed = speed * Math.cos(angle) * 3;
            const ySpeed = speed * Math.sin(angle) * 3 - 1;
            const sp = new Sprite(particleTex);
            sp.position.set(xSpeed * 24, ySpeed * 24);
            particleLayer.addChild(sp);
            particles.push({
              sprite: sp,
              xSpeed,
              ySpeed,
              age: 0,
              life: 2.0,
            });
          }
        }

        for (let i = particles.length - 1; i >= 0; i--) {
          const p = particles[i];
          p.age += dt;
          if (p.age >= p.life) {
            particleLayer.removeChild(p.sprite);
            p.sprite.destroy();
            particles.splice(i, 1);
            continue;
          }
          p.sprite.position.set(
            p.xSpeed * 120 * (p.age + 0.2),
            p.ySpeed * 120 * (p.age + 0.2) + 240 * p.age * p.age,
          );
          const fadeP = Math.min(1, p.age / 1.5);
          p.sprite.alpha = Math.max(0, 1 - easeout(fadeP));
        }
      }

      bgSprite.position.set(scrollPx, bgBaseY + scrollPx);
    };

    this.tickFn = onTick;
    this.stage.app.ticker.add(onTick);
  }

  public tryPlayTitleMusic(ghost = Boolean(this.persistence.data.ghost_menu)): void {
    if (!this.audio.isUnlocked()) {
      return;
    }
    const track = ghost ? "ghostmenu" : "t1";
    if (this.audio.getPlaying("music") === track) {
      return;
    }
    void this.audio.play("music", track).catch((err) => {
      console.warn("[TitleScreen] Could not play title music:", err);
    });
  }

  private mountNavigationDom(ghost: boolean): void {
    const nav = document.createElement("nav");
    nav.className = "ddlc-main-nav";
    nav.setAttribute("aria-label", "Main Menu");

    const playHover = (): void => {
      if (!this.audio.isUnlocked()) {
        return;
      }
      void this.audio
        .play("sfx", "gui/sfx/hover.ogg", { loop: false })
        .catch(() => {});
    };

    const playSelect = (): void => {
      void this.audio
        .unlock()
        .then(() => this.audio.play("sfx", "gui/sfx/select.ogg", { loop: false }))
        .catch(() => {});
    };

    const makeButton = (
      label: string,
      onClick: () => void,
      secondary = false,
    ): HTMLButtonElement => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = secondary
        ? "ddlc-nav-btn ddlc-nav-btn--secondary"
        : "ddlc-nav-btn";
      btn.textContent = label;
      btn.addEventListener("mouseenter", playHover);
      btn.addEventListener("click", () => {
        playSelect();
        onClick();
      });
      return btn;
    };

    if (ghost) {
      nav.appendChild(
        makeButton("End", () => {
          if (this.callbacks.onExitGhostMenu) {
            this.callbacks.onExitGhostMenu();
            return;
          }
          this.persistence.data.ghost_menu = false;
          this.persistence.savePersistent();
          this.hide();
          void this.show();
        }),
      );
    } else {
      const pt = Number(this.persistence.data.playthrough ?? 0);
      const newGameLabel = pt === 1 ? "ŔŗñĮ¼»ŧþŀÂŻŕěōì«" : "New Game";
      const newBtn = makeButton(newGameLabel, () => this.callbacks.onNewGame());
      nav.appendChild(newBtn);
      nav.appendChild(makeButton("Load Game", () => this.callbacks.onLoadGame()));
      nav.appendChild(makeButton("Settings", () => this.callbacks.onSettings()));
      nav.appendChild(makeButton("About", () => this.callbacks.onAbout()));
    }

    nav.appendChild(
      makeButton("characters/ Files", () => this.callbacks.onOpenVirtualFiles(), true),
    );

    this.stage.uiRoot.appendChild(nav);
    this.navEl = nav;
  }

  public hide(): void {
    if (!this.mounted) {
      return;
    }
    this.mounted = false;

    if (this.tickFn) {
      this.stage.app.ticker.remove(this.tickFn);
      this.tickFn = null;
    }

    this.stage.layers.screens.removeChild(this.root);
    this.root.removeChildren();

    if (this.navEl) {
      this.navEl.remove();
      this.navEl = null;
    }
  }
}
