import type { AssetLoader } from "../engine/AssetLoader";
import type { AudioEngine } from "../engine/AudioEngine";
import type { Persistence } from "../engine/Persistence";
import { glitchtext, type PyRuntime } from "../engine/PyRuntime";
import type { SceneManager } from "../engine/SceneManager";
import type { PoemWordEntry } from "../types/game-data";
import type { ModalScreens } from "./ModalScreens";

interface StickerState {
  id: "s" | "n" | "y" | "m";
  el: HTMLDivElement;
  idleUrl: string;
  hopUrl: string;
  baseX: number;
  xOffset: number;
  dir: number;
  flipX: number;
  nextMoveAt: number;
  moveEndAt: number;
  hoppingUntil: number;
}

const NON_UNICODE =
  "¡¢£¤¥¦§¨©ª«¬®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ";

/**
 * Complete implementation of DDLC's 20-word poem minigame (`script-poemgame.rpy`),
 * including Act 1, Act 2 glitches (`11111/20`, `glitchtext(80)`, `baa.ogg`,
 * `y_sticker_cut`, `y_sticker_2g`, `m_sticker`), Act 3 Monika-only words,
 * bouncing chibi stickers, and `seen_eyes` jumpscare easter egg.
 */
export class PoemGameScreen {
  private readonly root: HTMLDivElement;
  private readonly counterEl: HTMLDivElement;
  private readonly colLeftEl: HTMLDivElement;
  private readonly colRightEl: HTMLDivElement;
  private readonly stickerStageEl: HTMLDivElement;

  private stickers: StickerState[] = [];
  private rafId: number | null = null;

  public constructor(
    uiRoot: HTMLElement,
    private readonly wordPool: PoemWordEntry[],
    private readonly assets: AssetLoader,
    private readonly audio: AudioEngine,
    private readonly scene: SceneManager,
    private readonly persistence: Persistence,
    private readonly py: PyRuntime,
    private readonly modals: ModalScreens,
  ) {
    this.root = document.createElement("div");
    this.root.className = "ddlc-poemgame-layer is-hidden";

    this.counterEl = document.createElement("div");
    this.counterEl.className = "ddlc-poemgame-counter";

    this.colLeftEl = document.createElement("div");
    this.colLeftEl.className = "ddlc-poemgame-col ddlc-poemgame-col--left";

    this.colRightEl = document.createElement("div");
    this.colRightEl.className = "ddlc-poemgame-col ddlc-poemgame-col--right";

    this.stickerStageEl = document.createElement("div");
    this.stickerStageEl.className = "ddlc-poemgame-stickers";

    this.root.appendChild(this.counterEl);
    this.root.appendChild(this.colLeftEl);
    this.root.appendChild(this.colRightEl);
    this.root.appendChild(this.stickerStageEl);

    uiRoot.appendChild(this.root);
  }

  public async run(): Promise<void> {
    const pt = Number(this.persistence.data.playthrough ?? 0);
    const chapter = Number(this.py.getVar("chapter") ?? 0);
    const ch1Choice = String(this.py.getVar("ch1_choice") ?? "sayori");

    this.py.setVar("quick_menu", false);

    if (pt === 0 && !this.persistence.data.first_poem) {
      await this.modals.showDialog(
        "It's time to write a poem!\n\n" +
          "Pick words you think your favorite club member\n" +
          "will like. Something good might happen with\n" +
          "whoever likes your poem the most!",
      );
    }

    await this.audio.play("music", pt === 3 ? "ghostmenu" : "t4").catch(() => {});
    await this.scene.setScene(pt === 3 ? "bg notebook-glitch" : "bg notebook");
    await this.scene.runTransition("dissolve_scene_half");

    this.root.classList.remove("is-hidden");
    this.setupStickers(pt, chapter);
    this.startStickerLoop();

    const wordlist = [...this.wordPool];
    let progress = 1;
    const numWords = 20;
    let sPointTotal = 0;
    let nPointTotal = 0;
    let yPointTotal = 0;
    let poemgameGlitch = false;
    let playedBaa = false;

    while (progress <= numWords) {
      if (pt === 2 && chapter === 2) {
        this.counterEl.textContent = `${"1".repeat(progress)}/${numWords}`;
      } else {
        this.counterEl.textContent = `${progress}/${numWords}`;
      }

      const choices: Array<PoemWordEntry & { glitch?: boolean }> = [];
      for (let i = 0; i < 10; i++) {
        if (pt === 3) {
          const chars = Array.from("Monika");
          for (let k = 0; k < 6; k++) {
            if (Math.random() < 0.2) {
              chars[k] = " ";
            } else if (Math.random() < 0.2) {
              chars[k] =
                NON_UNICODE[Math.floor(Math.random() * NON_UNICODE.length)];
            }
          }
          choices.push({
            word: chars.join(""),
            sayori: 0,
            natsuki: 0,
            yuri: 0,
          });
        } else if (
          pt === 2 &&
          !poemgameGlitch &&
          chapter >= 1 &&
          progress < numWords &&
          Math.floor(Math.random() * 401) === 0
        ) {
          choices.push({
            word: glitchtext(80),
            sayori: 0,
            natsuki: 0,
            yuri: 0,
            glitch: true,
          });
        } else {
          const idx = Math.floor(Math.random() * wordlist.length);
          const picked = wordlist.splice(idx, 1)[0];
          if (picked) {
            choices.push(picked);
          }
        }
      }

      const chosen = await this.promptWordBatch(choices);

      if (!poemgameGlitch) {
        if (chosen.glitch) {
          poemgameGlitch = true;
          await this.audio.play("music", "t4g").catch(() => {});
          await this.scene.setScene("white");
          this.setGlitchStickerMode();
        } else if (pt !== 3) {
          void this.audio
            .play("sfx", "gui/sfx/select.ogg", { loop: false })
            .catch(() => {});
          if (pt === 0) {
            if (chosen.sayori >= 3) this.hopSticker("s");
            if (chosen.natsuki >= 3) this.hopSticker("n");
            if (chosen.yuri >= 3) this.hopSticker("y");
          } else {
            if (pt === 2 && chapter === 2 && Math.floor(Math.random() * 11) === 0) {
              this.hopSticker("m");
            } else if (chosen.natsuki > chosen.yuri) {
              this.hopSticker("n");
            } else {
              this.hopSticker("y");
            }
          }
        }
      } else {
        const r = Math.floor(Math.random() * 11);
        if (r === 0 && !playedBaa) {
          playedBaa = true;
          void this.audio
            .play("sfx", "gui/sfx/baa.ogg", { loop: false })
            .catch(() => {});
        } else if (r <= 5) {
          void this.audio
            .play("sfx", "gui/sfx/select_glitch.ogg", { loop: false })
            .catch(() => {});
        }
      }

      sPointTotal += chosen.sayori;
      nPointTotal += chosen.natsuki;
      yPointTotal += chosen.yuri;
      progress += 1;
    }

    this.stopStickerLoop();
    this.root.classList.add("is-hidden");

    // Store poem scores identically to `script-poemgame.rpy`
    if (pt === 0) {
      if (chapter === 1) {
        if (ch1Choice.startsWith("s")) sPointTotal += 5;
        else if (ch1Choice.startsWith("n")) nPointTotal += 5;
        else yPointTotal += 5;
      }
      const pairs: Array<["sayori" | "natsuki" | "yuri", number]> = [
        ["sayori", sPointTotal],
        ["natsuki", nPointTotal],
        ["yuri", yPointTotal],
      ];
      pairs.sort((a, b) => a[1] - b[1]);
      const winner = pairs[2][0];
      this.setPoemWinner(chapter, winner);
      this.incrementAppeal(winner);
    } else {
      const winner = nPointTotal > yPointTotal ? "natsuki" : "yuri";
      this.setPoemWinner(chapter, winner);
      this.incrementAppeal(winner);
    }

    this.updatePoemAppeal("s_poemappeal", chapter, sPointTotal);
    this.updatePoemAppeal("n_poemappeal", chapter, nPointTotal);
    this.updatePoemAppeal("y_poemappeal", chapter, yPointTotal);
    const winnerName = (this.py.getVar("poemwinner") as string[])[chapter];
    if (winnerName) {
      this.updatePoemAppeal(`${winnerName[0]}_poemappeal`, chapter, 999);
    }

    // Act 2 Yuri `seen_eyes` easter egg
    if (
      pt === 2 &&
      !this.persistence.data.seen_eyes &&
      Math.floor(Math.random() * 6) === 0
    ) {
      this.persistence.data.seen_eyes = true;
      this.persistence.savePersistent();
      this.audio.stop("music", 0);
      await this.scene.setScene("bg eyes");
      await new Promise((r) => window.setTimeout(r, 1200));
      await this.scene.setScene("black");
      await new Promise((r) => window.setTimeout(r, 500));
    }

    this.py.setVar("quick_menu", true);
  }

  private setPoemWinner(chapter: number, winner: string): void {
    const arr = this.py.getVar("poemwinner");
    if (Array.isArray(arr)) {
      arr[chapter] = winner;
    }
  }

  private incrementAppeal(winner: string): void {
    const key = `${winner[0]}_appeal`;
    this.py.setVar(key, Number(this.py.getVar(key) ?? 0) + 1);
  }

  private updatePoemAppeal(
    varName: string,
    chapter: number,
    points: number,
  ): void {
    const arr = this.py.getVar(varName);
    if (!Array.isArray(arr)) {
      return;
    }
    if (points === 999) {
      arr[chapter] = 1;
    } else if (points < 29) {
      arr[chapter] = -1;
    } else if (points > 45) {
      arr[chapter] = 1;
    }
  }

  private promptWordBatch(
    words: Array<PoemWordEntry & { glitch?: boolean }>,
  ): Promise<PoemWordEntry & { glitch?: boolean }> {
    this.colLeftEl.innerHTML = "";
    this.colRightEl.innerHTML = "";

    return new Promise((resolve) => {
      words.forEach((entry, idx) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ddlc-poemgame-word";
        btn.textContent = entry.word;
        btn.addEventListener("click", () => {
          resolve(entry);
        });
        if (idx < 5) {
          this.colLeftEl.appendChild(btn);
        } else {
          this.colRightEl.appendChild(btn);
        }
      });
    });
  }

  private setupStickers(pt: number, chapter: number): void {
    this.stickerStageEl.innerHTML = "";
    this.stickers = [];

    const mkSticker = (
      id: "s" | "n" | "y" | "m",
      idlePath: string,
      hopPath: string,
      baseX: number,
      bottomPx = 42,
    ): void => {
      const el = document.createElement("div");
      el.className = "ddlc-sticker";
      el.style.left = `${baseX}px`;
      el.style.bottom = `${bottomPx}px`;
      const idleUrl = `url("${this.assets.getAssetUrl(idlePath)}")`;
      const hopUrl = `url("${this.assets.getAssetUrl(hopPath)}")`;
      el.style.backgroundImage = idleUrl;
      this.stickerStageEl.appendChild(el);

      this.stickers.push({
        id,
        el,
        idleUrl,
        hopUrl,
        baseX,
        xOffset: 0,
        dir: 0,
        flipX: 1,
        nextMoveAt: performance.now() + 2000 + Math.random() * 4000,
        moveEndAt: 0,
        hoppingUntil: 0,
      });
    };

    if (pt === 0) {
      mkSticker("s", "gui/poemgame/s_sticker_1.png", "gui/poemgame/s_sticker_2.png", 100);
      mkSticker("n", "gui/poemgame/n_sticker_1.png", "gui/poemgame/n_sticker_2.png", 220);
      mkSticker("y", "gui/poemgame/y_sticker_1.png", "gui/poemgame/y_sticker_2.png", 340);
    } else if (pt !== 3) {
      mkSticker("n", "gui/poemgame/n_sticker_1.png", "gui/poemgame/n_sticker_2.png", 220);
      if (pt === 2 && chapter === 2) {
        mkSticker(
          "y",
          "gui/poemgame/y_sticker_cut_1.png",
          "gui/poemgame/y_sticker_cut_2.png",
          340,
        );
        mkSticker("m", "gui/poemgame/m_sticker_1.png", "gui/poemgame/m_sticker_2.png", 100, -180);
      } else {
        mkSticker("y", "gui/poemgame/y_sticker_1.png", "gui/poemgame/y_sticker_2.png", 340);
      }
    }
  }

  private setGlitchStickerMode(): void {
    this.stickerStageEl.innerHTML = "";
    this.stickers = [];
    const el = document.createElement("div");
    el.className = "ddlc-sticker";
    el.style.left = "50px";
    el.style.bottom = "-40px";
    el.style.backgroundImage = `url("${this.assets.getAssetUrl("gui/poemgame/y_sticker_1_broken.png")}")`;
    this.stickerStageEl.appendChild(el);
  }

  private hopSticker(id: "s" | "n" | "y" | "m"): void {
    const st = this.stickers.find((x) => x.id === id);
    if (!st) {
      return;
    }
    st.hoppingUntil = performance.now() + 720;
    st.el.style.backgroundImage = st.hopUrl;
    if (id === "m") {
      st.el.style.bottom = "42px";
      window.setTimeout(() => {
        st.el.style.bottom = "-180px";
      }, 720);
    }
  }

  private startStickerLoop(): void {
    const loop = (now: number): void => {
      for (const st of this.stickers) {
        let hopY = 0;
        if (now < st.hoppingUntil) {
          const p = 1 - (st.hoppingUntil - now) / 720;
          const bouncePhase = (p * 2) % 1;
          hopY = -Math.sin(bouncePhase * Math.PI) * 80;
        } else {
          st.el.style.backgroundImage = st.idleUrl;
        }

        if (now >= st.nextMoveAt && st.moveEndAt === 0) {
          st.dir = Math.floor(Math.random() * 3) - 1;
          st.moveEndAt = now + 160;
        }
        if (st.moveEndAt > 0) {
          if (now < st.moveEndAt) {
            st.xOffset += st.dir * 0.45;
            if (st.dir > 0) st.flipX = -1;
            else if (st.dir < 0) st.flipX = 1;
          } else {
            st.moveEndAt = 0;
            st.nextMoveAt = now + 3000 + Math.random() * 4000;
          }
        }

        st.el.style.transform = `translate(${st.xOffset}px, ${hopY}px) scaleX(${st.flipX})`;
      }
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private stopStickerLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
}
