import type { AssetLoader } from "../engine/AssetLoader";
import type { AudioEngine } from "../engine/AudioEngine";
import type { Persistence, SaveSlot } from "../engine/Persistence";
import type { VirtualFS } from "../engine/VirtualFS";
import type { ModalScreens } from "./ModalScreens";

export type GameMenuTab = "history" | "save" | "load" | "settings" | "about";

export interface GameMenuCallbacks {
  onCaptureSaveData: (slot: number) => SaveSlot;
  onLoadSaveSlot: (slot: SaveSlot) => Promise<void>;
  onRestartNewGame: () => void;
  onMainMenu: () => void;
  onOpenChange?: (open: boolean) => void;
}

/**
 * DDLC's in-game & title-accessible menu (`screens.rpy` `game_menu`):
 * scrolling `menu_bg.png`, `gui/overlay/game_menu.png`, 3x2 save/load slots,
 * dialogue history, preferences, about, and Act 2/3 `FileActionMod` easter eggs.
 */
export class GameMenuScreen {
  private readonly root: HTMLDivElement;
  private readonly titleEl: HTMLDivElement;
  private readonly navEl: HTMLElement;
  private readonly contentEl: HTMLDivElement;
  private currentTab: GameMenuTab = "save";
  private inGame = false;

  public constructor(
    uiRoot: HTMLElement,
    private readonly assets: AssetLoader,
    private readonly audio: AudioEngine,
    private readonly persistence: Persistence,
    private readonly vfs: VirtualFS,
    private readonly modals: ModalScreens,
    private readonly callbacks: GameMenuCallbacks,
  ) {
    this.root = document.createElement("div");
    this.root.className = "ddlc-gamemenu-layer is-hidden";

    const bg = document.createElement("div");
    bg.className = "ddlc-gamemenu-bg";
    bg.style.backgroundImage = `url("${this.assets.getAssetUrl("gui/menu_bg.png")}")`;

    const overlay = document.createElement("div");
    overlay.className = "ddlc-gamemenu-overlay";
    overlay.style.backgroundImage = `url("${this.assets.getAssetUrl("gui/overlay/game_menu.png")}")`;

    this.titleEl = document.createElement("div");
    this.titleEl.className = "ddlc-gamemenu-title";

    this.navEl = document.createElement("nav");
    this.navEl.className = "ddlc-gamemenu-nav";

    this.contentEl = document.createElement("div");
    this.contentEl.className = "ddlc-gamemenu-content";

    this.root.appendChild(bg);
    this.root.appendChild(overlay);
    this.root.appendChild(this.titleEl);
    this.root.appendChild(this.navEl);
    this.root.appendChild(this.contentEl);

    uiRoot.appendChild(this.root);
  }

  public open(tab: GameMenuTab, inGame: boolean): void {
    this.currentTab = tab;
    this.inGame = inGame;
    this.root.classList.remove("is-hidden");
    this.callbacks.onOpenChange?.(true);
    this.renderNav();
    this.renderTab();
  }

  public close(): void {
    this.root.classList.add("is-hidden");
    this.callbacks.onOpenChange?.(false);
  }

  public isOpen(): boolean {
    return !this.root.classList.contains("is-hidden");
  }

  private renderNav(): void {
    this.navEl.innerHTML = "";
    const items: Array<{ label: string; tab?: GameMenuTab; action?: () => void }> = [];

    if (this.inGame) {
      items.push({ label: "History", tab: "history" });
      items.push({ label: "Save Game", tab: "save" });
    }
    items.push({ label: "Load Game", tab: "load" });
    items.push({ label: "Settings", tab: "settings" });
    items.push({ label: "About", tab: "about" });
    if (this.inGame) {
      items.push({
        label: "Main Menu",
        action: async () => {
          const ok = await this.modals.showConfirm(
            "Are you sure you want to return to the main menu?\nThis will lose unsaved progress.",
          );
          if (ok) {
            this.close();
            this.callbacks.onMainMenu();
          }
        },
      });
    }
    items.push({
      label: "Return",
      action: () => this.close(),
    });

    for (const item of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        item.tab === this.currentTab
          ? "ddlc-nav-btn ddlc-nav-btn--active"
          : "ddlc-nav-btn";
      btn.textContent = item.label;
      btn.addEventListener("mouseenter", () => {
        if (this.audio.isUnlocked()) {
          void this.audio
            .play("sfx", "gui/sfx/hover.ogg", { loop: false })
            .catch(() => {});
        }
      });
      btn.addEventListener("click", () => {
        if (this.audio.isUnlocked()) {
          void this.audio
            .play("sfx", "gui/sfx/select.ogg", { loop: false })
            .catch(() => {});
        }
        if (item.tab) {
          this.currentTab = item.tab;
          this.renderNav();
          this.renderTab();
        } else if (item.action) {
          item.action();
        }
      });
      this.navEl.appendChild(btn);
    }
  }

  private renderTab(): void {
    this.contentEl.innerHTML = "";
    const titles: Record<GameMenuTab, string> = {
      history: "History",
      save: "Save",
      load: "Load",
      settings: "Settings",
      about: "About",
    };
    this.titleEl.textContent = titles[this.currentTab];

    if (this.currentTab === "history") {
      this.renderHistory();
    } else if (this.currentTab === "save" || this.currentTab === "load") {
      this.renderSlots(this.currentTab);
    } else if (this.currentTab === "settings") {
      this.renderSettings();
    } else {
      this.renderAbout();
    }
  }

  private renderHistory(): void {
    const list = document.createElement("div");
    list.className = "ddlc-history-list";
    const entries = [...this.persistence.history].reverse();

    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ddlc-history-empty";
      empty.textContent = "The dialogue history is empty.";
      list.appendChild(empty);
    } else {
      for (const entry of entries) {
        const row = document.createElement("div");
        row.className = "ddlc-history-row";

        const who = document.createElement("div");
        who.className = "ddlc-history-who";
        who.textContent = entry.who ?? "";

        const what = document.createElement("div");
        what.className = "ddlc-history-what";
        what.textContent = entry.what;

        row.appendChild(who);
        row.appendChild(what);
        list.appendChild(row);
      }
    }
    this.contentEl.appendChild(list);
  }

  private renderSlots(mode: "save" | "load"): void {
    const grid = document.createElement("div");
    grid.className = "ddlc-slot-grid";

    const idleSlotBg = this.assets.getAssetUrl("gui/button/slot_idle_background.png");
    const hoverSlotBg = this.assets.getAssetUrl("gui/button/slot_hover_background.png");

    for (let slotNum = 1; slotNum <= 6; slotNum++) {
      const existing = this.persistence.readSlot(slotNum);
      const card = document.createElement("button");
      card.type = "button";
      card.className = "ddlc-slot-card";
      card.style.backgroundImage = `url("${idleSlotBg}")`;

      card.addEventListener("mouseenter", () => {
        card.style.backgroundImage = `url("${hoverSlotBg}")`;
      });
      card.addEventListener("mouseleave", () => {
        card.style.backgroundImage = `url("${idleSlotBg}")`;
      });

      const thumb = document.createElement("div");
      thumb.className = "ddlc-slot-thumb";
      if (existing?.thumbnail) {
        const img = document.createElement("img");
        img.src = existing.thumbnail;
        img.alt = `Slot ${slotNum}`;
        thumb.appendChild(img);
      } else {
        thumb.textContent = "Empty Slot";
      }

      const meta = document.createElement("div");
      meta.className = "ddlc-slot-meta";
      meta.textContent = existing
        ? `${existing.savedAt}\n${existing.caption}`
        : `Slot ${slotNum}`;

      card.appendChild(thumb);
      card.appendChild(meta);

      card.addEventListener("click", () => {
        void this.handleSlotClick(mode, slotNum, existing);
      });
      grid.appendChild(card);
    }

    this.contentEl.appendChild(grid);
  }

  private async handleSlotClick(
    mode: "save" | "load",
    slotNum: number,
    existing: SaveSlot | null,
  ): Promise<void> {
    const pt = this.persistence.data.playthrough;

    // `FileActionMod` from `screens.rpy`: Act 3 blocks saving
    if (mode === "save" && pt === 3) {
      await this.modals.showDialog(
        "There's no point in saving anymore.\nDon't worry, I'm not going anywhere.",
      );
      return;
    }

    // `FileActionMod` from `screens.rpy`: Act 2 blocks loading old Act 1 saves
    if (
      mode === "load" &&
      pt === 1 &&
      !this.persistence.data.deleted_saves &&
      existing !== null
    ) {
      await this.modals.showDialog(
        'File error: "characters/sayori.chr"\n\nThe file is missing or corrupt.',
      );
      await this.modals.showDialog(
        "The save file is corrupt. Starting a new game.",
      );
      this.close();
      this.callbacks.onRestartNewGame();
      return;
    }

    if (mode === "save") {
      if (existing) {
        const ok = await this.modals.showConfirm(
          "Are you sure you want to overwrite your save?",
        );
        if (!ok) {
          return;
        }
      }
      const snapshot = this.callbacks.onCaptureSaveData(slotNum);
      this.persistence.writeSlot(snapshot);
      this.renderTab();
      return;
    }

    if (existing) {
      if (this.inGame) {
        const ok = await this.modals.showConfirm(
          "Are you sure you want to load this game?\nUnsaved progress will be lost.",
        );
        if (!ok) {
          return;
        }
      }
      this.close();
      await this.callbacks.onLoadSaveSlot(existing);
    }
  }

  private renderSettings(): void {
    const prefs = this.persistence.data.preferences;
    const panel = document.createElement("div");
    panel.className = "ddlc-prefs-panel";

    const addSlider = (
      label: string,
      value: number,
      min: number,
      max: number,
      step: number,
      onChange: (val: number) => void,
    ): void => {
      const row = document.createElement("label");
      row.className = "ddlc-pref-row";

      const title = document.createElement("span");
      title.className = "ddlc-pref-label";
      title.textContent = label;

      const input = document.createElement("input");
      input.type = "range";
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(value);
      input.addEventListener("input", () => {
        onChange(parseFloat(input.value));
        this.persistence.savePersistent();
      });

      row.appendChild(title);
      row.appendChild(input);
      panel.appendChild(row);
    };

    addSlider("Music Volume", prefs.musicVolume, 0, 1, 0.05, (v) => {
      prefs.musicVolume = v;
      this.audio.setVolume("music", v);
      this.audio.setVolume("music_poem", v);
    });

    addSlider("Sound Volume", prefs.sfxVolume, 0, 1, 0.05, (v) => {
      prefs.sfxVolume = v;
      this.audio.setVolume("sound", v);
      this.audio.setVolume("sfx", v);
    });

    addSlider("Text Speed (CPS)", prefs.textCps, 15, 160, 5, (v) => {
      prefs.textCps = v;
    });

    addSlider("Auto-Forward Time (s)", prefs.autoForwardTime, 1, 15, 1, (v) => {
      prefs.autoForwardTime = v;
    });

    const skipLabel = document.createElement("label");
    skipLabel.className = "ddlc-pref-check";
    const skipCheck = document.createElement("input");
    skipCheck.type = "checkbox";
    skipCheck.checked = prefs.skipUnseen;
    skipCheck.addEventListener("change", () => {
      prefs.skipUnseen = skipCheck.checked;
      this.persistence.savePersistent();
    });
    skipLabel.appendChild(skipCheck);
    skipLabel.appendChild(document.createTextNode(" Skip Unseen Text"));
    panel.appendChild(skipLabel);

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "ddlc-btn-small ddlc-btn-danger";
    resetBtn.style.marginTop = "18px";
    resetBtn.textContent = "Reset Persistent & Save Data (Fresh Install)";
    resetBtn.addEventListener("click", async () => {
      const ok = await this.modals.showConfirm(
        "Delete all saves, reset persistent data, and restore characters/?",
      );
      if (ok) {
        this.persistence.clearAllSaves();
        this.persistence.resetPersistent();
        this.vfs.resetToInitial();
        this.close();
        this.callbacks.onMainMenu();
      }
    });
    panel.appendChild(resetBtn);

    this.contentEl.appendChild(panel);
  }

  private renderAbout(): void {
    const box = document.createElement("div");
    box.className = "ddlc-about-box";
    box.innerHTML = `
      <h3>Doki Doki Literature Club! — Web Port</h3>
      <p>Near pixel-perfect browser port powered by <strong>PixiJS v8</strong>, <strong>Web Audio API</strong> (+ WASM Ogg Vorbis), and a pure-Python RPA/RPYC asset compiler.</p>
      <p>No copyrighted DDLC assets are bundled in the repository; all art, audio, fonts, and scripts are extracted locally from your own copy of <code>ddlc-win.zip</code>.</p>
      <p>Original game &copy; Team Salvato (<code>https://ddlc.moe</code>).</p>
    `;
    this.contentEl.appendChild(box);
  }
}
