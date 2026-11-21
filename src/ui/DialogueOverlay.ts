import type { AssetLoader } from "../engine/AssetLoader";
import type { AudioEngine } from "../engine/AudioEngine";
import type { Persistence } from "../engine/Persistence";
import { parseRenpyText, type TextSpan } from "./TextParser";

export interface DialogueOverlayCallbacks {
  onOpenHistory: () => void;
  onOpenSave: () => void;
  onOpenLoad: () => void;
  onQuickSave: () => void;
  onQuickLoad: () => void;
  onOpenSettings: () => void;
  onOpenVirtualFiles: () => void;
  onToggleSkip: (skipping: boolean) => void;
}

/**
 * Pixel-locked 1280x720 Ren'Py Say, Choice, and Rigged-Choice UI overlay
 * using DDLC's real extracted textbox.png, namebox.png, ctc.png, choice
 * button art, quick menu, and TrueType fonts.
 */
export class DialogueOverlay {
  private readonly layerEl: HTMLDivElement;
  private readonly nameboxEl: HTMLDivElement;
  private readonly textboxEl: HTMLDivElement;
  private readonly textEl: HTMLDivElement;
  private readonly ctcEl: HTMLDivElement;
  private readonly quickMenuEl: HTMLDivElement;
  private readonly choiceEl: HTMLDivElement;

  private advanceResolver: (() => void) | null = null;
  private isTyping = false;
  private fullSpans: TextSpan[] = [];
  private typeTimer: number | null = null;
  private afmTimer: number | null = null;
  private skipInterval: number | null = null;
  private dialogueStyle = "normal";
  private quickMenuVisible = true;
  private monikaTextbox = false;
  private windowsHidden = false;
  private skipping = false;
  private autoForward = false;
  private currentLineSeen = false;
  private interactiveChoiceOpen = false;
  private readonly activeOverlays = new Set<string>();

  private keyDownHandler: ((ev: KeyboardEvent) => void) | null = null;
  private keyUpHandler: ((ev: KeyboardEvent) => void) | null = null;
  private blurHandler: (() => void) | null = null;

  public constructor(
    uiRoot: HTMLElement,
    private readonly assets: AssetLoader,
    private readonly audio: AudioEngine,
    private readonly persistence: Persistence,
    private readonly callbacks: DialogueOverlayCallbacks,
  ) {
    this.layerEl = document.createElement("div");
    this.layerEl.className = "ddlc-dialogue-layer is-hidden";

    const wrap = document.createElement("div");
    wrap.className = "ddlc-textbox-wrap";

    this.nameboxEl = document.createElement("div");
    this.nameboxEl.className = "ddlc-namebox is-hidden";
    this.nameboxEl.style.backgroundImage = `url("${this.assets.getAssetUrl("gui/namebox.png")}")`;

    this.textboxEl = document.createElement("div");
    this.textboxEl.className = "ddlc-textbox";
    this.textboxEl.style.backgroundImage = `url("${this.assets.getAssetUrl("gui/textbox.png")}")`;

    this.textEl = document.createElement("div");
    this.textEl.className = "ddlc-dialogue-text";

    this.ctcEl = document.createElement("div");
    this.ctcEl.className = "ddlc-ctc is-hidden";
    this.ctcEl.style.backgroundImage = `url("${this.assets.getAssetUrl("gui/ctc.png")}")`;

    this.textboxEl.appendChild(this.textEl);
    this.textboxEl.appendChild(this.ctcEl);
    wrap.appendChild(this.nameboxEl);
    wrap.appendChild(this.textboxEl);
    this.layerEl.appendChild(wrap);

    this.quickMenuEl = this.buildQuickMenu();
    this.layerEl.appendChild(this.quickMenuEl);

    this.choiceEl = document.createElement("div");
    this.choiceEl.className = "ddlc-choice-layer is-hidden";

    this.layerEl.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).closest(".ddlc-quick-menu")) {
        return;
      }
      if (this.windowsHidden) {
        this.setWindowsHidden(false);
        return;
      }
      this.handleAdvanceInput();
    });

    this.layerEl.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      this.setWindowsHidden(!this.windowsHidden);
    });

    uiRoot.appendChild(this.layerEl);
    uiRoot.appendChild(this.choiceEl);

    this.bindKeyboard();
  }

  private buildQuickMenu(): HTMLDivElement {
    const bar = document.createElement("div");
    bar.className = "ddlc-quick-menu";

    const items: Array<{ label: string; action: () => void }> = [
      { label: "History", action: () => this.callbacks.onOpenHistory() },
      { label: "Skip", action: () => this.toggleSkip() },
      { label: "Auto", action: () => this.toggleAutoForward() },
      { label: "Save", action: () => this.callbacks.onOpenSave() },
      { label: "Q.Save", action: () => this.callbacks.onQuickSave() },
      { label: "Q.Load", action: () => this.callbacks.onQuickLoad() },
      { label: "Load", action: () => this.callbacks.onOpenLoad() },
      { label: "Settings", action: () => this.callbacks.onOpenSettings() },
      { label: "characters/", action: () => this.callbacks.onOpenVirtualFiles() },
    ];

    for (const item of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ddlc-quick-btn";
      btn.textContent = item.label;
      btn.dataset.quickAction = item.label.toLowerCase();
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        item.action();
      });
      bar.appendChild(btn);
    }

    return bar;
  }

  public setQuickMenuVisible(visible: boolean): void {
    this.quickMenuVisible = visible;
    this.quickMenuEl.classList.toggle("is-hidden", !visible);
  }

  public setDialogueStyle(styleName: string): void {
    this.dialogueStyle = styleName;
    this.textEl.classList.toggle("ddlc-dialogue-text--edited", styleName === "edited");
  }

  public setMonikaTextbox(active: boolean): void {
    this.monikaTextbox = active;
    const tex = active ? "gui/textbox_monika.png" : "gui/textbox.png";
    this.textboxEl.style.backgroundImage = `url("${this.assets.getAssetUrl(tex)}")`;
  }

  public getUiState(): {
    dialogueStyle: string;
    quickMenuVisible: boolean;
    monikaTextbox: boolean;
  } {
    return {
      dialogueStyle: this.dialogueStyle,
      quickMenuVisible: this.quickMenuVisible,
      monikaTextbox: this.monikaTextbox,
    };
  }

  public setWindowsHidden(hidden: boolean): void {
    this.windowsHidden = hidden;
    this.layerEl.style.opacity = hidden ? "0" : "1";
  }

  public isSkipping(): boolean {
    return this.skipping;
  }

  public isOverlayPaused(): boolean {
    return this.activeOverlays.size > 0;
  }

  public setOverlayOpen(id: string, open: boolean): void {
    if (open) {
      this.activeOverlays.add(id);
      if (this.afmTimer !== null) {
        window.clearTimeout(this.afmTimer);
        this.afmTimer = null;
      }
      this.callbacks.onToggleSkip(false);
    } else {
      this.activeOverlays.delete(id);
      if (this.activeOverlays.size === 0) {
        this.callbacks.onToggleSkip(this.skipping);
        if (this.autoForward && !this.isTyping && this.advanceResolver) {
          this.scheduleAutoForward();
        }
      }
    }
  }

  public setSkipping(active: boolean): void {
    if (
      active &&
      !this.currentLineSeen &&
      !this.persistence.data.preferences.skipUnseen
    ) {
      return;
    }
    if (this.skipping === active) {
      return;
    }
    this.skipping = active;
    this.callbacks.onToggleSkip(active && this.activeOverlays.size === 0);
    const skipBtn = this.quickMenuEl.querySelector('[data-quick-action="skip"]');
    skipBtn?.classList.toggle("is-active", active);

    if (this.skipInterval !== null) {
      window.clearInterval(this.skipInterval);
      this.skipInterval = null;
    }

    if (active) {
      this.skipInterval = window.setInterval(() => {
        if (this.activeOverlays.size > 0) {
          return;
        }
        if (
          !this.currentLineSeen &&
          !this.persistence.data.preferences.skipUnseen
        ) {
          this.setSkipping(false);
          return;
        }
        if (
          !this.layerEl.classList.contains("is-hidden") &&
          !this.interactiveChoiceOpen
        ) {
          this.handleAdvanceInput();
        }
      }, 45);
    }
  }

  private toggleSkip(): void {
    this.setSkipping(!this.skipping);
  }

  public setAutoForward(active: boolean): void {
    this.autoForward = active;
    const autoBtn = this.quickMenuEl.querySelector('[data-quick-action="auto"]');
    autoBtn?.classList.toggle("is-active", active);
    if (
      active &&
      this.activeOverlays.size === 0 &&
      !this.isTyping &&
      this.advanceResolver
    ) {
      this.scheduleAutoForward();
    } else if (!active && this.afmTimer !== null) {
      window.clearTimeout(this.afmTimer);
      this.afmTimer = null;
    }
  }

  private toggleAutoForward(): void {
    this.setAutoForward(!this.autoForward);
  }

  private bindKeyboard(): void {
    const onKeyDown = (ev: KeyboardEvent): void => {
      if (
        this.layerEl.classList.contains("is-hidden") ||
        this.activeOverlays.size > 0
      ) {
        return;
      }
      if (ev.key === "F5" || (ev.shiftKey && ev.key.toLowerCase() === "s")) {
        if (!this.interactiveChoiceOpen) {
          ev.preventDefault();
          this.callbacks.onQuickSave();
        }
        return;
      }
      if (ev.key === "F9" || (ev.shiftKey && ev.key.toLowerCase() === "l")) {
        if (!this.interactiveChoiceOpen) {
          ev.preventDefault();
          this.callbacks.onQuickLoad();
        }
        return;
      }
      if (ev.key === "Control") {
        this.setSkipping(true);
        return;
      }
      if (ev.key === "h" || ev.key === "H") {
        if (!this.interactiveChoiceOpen) {
          this.setWindowsHidden(!this.windowsHidden);
        }
        return;
      }
      if (this.interactiveChoiceOpen) {
        return;
      }
      if (ev.key === " " || ev.key === "Enter") {
        ev.preventDefault();
        if (this.windowsHidden) {
          this.setWindowsHidden(false);
          return;
        }
        this.handleAdvanceInput();
      }
    };

    const onKeyUp = (ev: KeyboardEvent): void => {
      if (ev.key === "Control") {
        this.setSkipping(false);
      }
    };

    const onBlur = (): void => {
      this.setSkipping(false);
    };

    this.keyDownHandler = onKeyDown;
    this.keyUpHandler = onKeyUp;
    this.blurHandler = onBlur;
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
  }

  public showStaticPrompt(speaker: string | null, rawText: string): void {
    this.layerEl.classList.remove("is-hidden");
    this.setQuickMenuVisible(this.quickMenuVisible);
    this.setSpeaker(speaker);
    const parsed = parseRenpyText(rawText);
    this.renderSpansUpTo(parsed.spans, parsed.plainText.length);
    this.ctcEl.classList.add("is-hidden");
  }

  public showLine(
    speaker: string | null,
    rawText: string,
    interact = true,
    seen = false,
  ): Promise<void> {
    this.clearTimers();
    this.currentLineSeen = seen;
    this.layerEl.classList.remove("is-hidden");
    this.setQuickMenuVisible(this.quickMenuVisible);
    this.setSpeaker(speaker);

    const parsed = parseRenpyText(rawText);
    this.fullSpans = parsed.spans;
    const totalChars = parsed.plainText.length;

    if (!interact) {
      this.renderSpansUpTo(this.fullSpans, totalChars);
      return Promise.resolve();
    }

    const canSkipThis =
      this.skipping && (seen || this.persistence.data.preferences.skipUnseen);
    if (this.skipping && !canSkipThis) {
      this.setSkipping(false);
    }

    if (totalChars === 0 || canSkipThis) {
      this.renderSpansUpTo(this.fullSpans, totalChars);
      this.ctcEl.classList.remove("is-hidden");
      if (parsed.noWait) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        this.advanceResolver = resolve;
      });
    }

    return new Promise<void>((resolve) => {
      this.advanceResolver = resolve;
      this.isTyping = true;
      this.ctcEl.classList.add("is-hidden");

      const baseCps =
        this.dialogueStyle === "default_monika"
          ? 30
          : this.persistence.data.preferences.textCps || 50;

      const cps = parsed.spans[0]?.style.cps ?? baseCps;
      const intervalMs = Math.max(8, Math.floor(1000 / Math.max(10, cps)));

      let shown = 0;
      this.renderSpansUpTo(this.fullSpans, 0);

      this.typeTimer = window.setInterval(() => {
        shown += 1;
        this.renderSpansUpTo(this.fullSpans, shown);
        if (shown >= totalChars) {
          this.finishTyping();
          if (parsed.noWait) {
            this.resolveAdvance();
          } else if (this.autoForward && this.activeOverlays.size === 0) {
            this.scheduleAutoForward();
          }
        }
      }, intervalMs);
    });
  }

  private scheduleAutoForward(): void {
    if (this.afmTimer !== null) {
      window.clearTimeout(this.afmTimer);
      this.afmTimer = null;
    }
    if (this.activeOverlays.size > 0) {
      return;
    }
    const waitMs = Math.max(
      1000,
      (this.persistence.data.preferences.autoForwardTime || 5) * 1000,
    );
    this.afmTimer = window.setTimeout(() => {
      if (
        this.autoForward &&
        this.activeOverlays.size === 0 &&
        !this.isTyping &&
        this.advanceResolver
      ) {
        this.resolveAdvance();
      }
    }, waitMs);
  }

  public showPassiveChoices(options: string[]): void {
    this.interactiveChoiceOpen = false;
    this.choiceEl.innerHTML = "";
    this.choiceEl.classList.remove("is-hidden");
    this.choiceEl.style.pointerEvents = "none";
    const idleBg = this.assets.getAssetUrl("gui/button/choice_idle_background.png");
    for (const label of options) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ddlc-choice-btn";
      btn.textContent = label;
      btn.disabled = true;
      btn.style.backgroundImage = `url("${idleBg}")`;
      this.choiceEl.appendChild(btn);
    }
  }

  public hideChoices(): void {
    this.interactiveChoiceOpen = false;
    this.choiceEl.style.pointerEvents = "";
    this.choiceEl.classList.add("is-hidden");
    this.choiceEl.innerHTML = "";
  }

  public showChoices(options: string[], rigged = false): Promise<number> {
    this.setSkipping(false);
    this.interactiveChoiceOpen = true;
    this.choiceEl.style.pointerEvents = "";
    this.choiceEl.innerHTML = "";
    this.choiceEl.classList.remove("is-hidden");

    const idleBg = this.assets.getAssetUrl("gui/button/choice_idle_background.png");
    const hoverBg = this.assets.getAssetUrl("gui/button/choice_hover_background.png");

    return new Promise<number>((resolve) => {
      options.forEach((label, idx) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ddlc-choice-btn";
        btn.textContent = label;
        btn.style.backgroundImage = `url("${idleBg}")`;

        btn.addEventListener("mouseenter", () => {
          btn.style.backgroundImage = `url("${hoverBg}")`;
          if (this.audio.isUnlocked()) {
            void this.audio
              .play("sfx", "gui/sfx/hover.ogg", { loop: false })
              .catch(() => {});
          }
          // Act 2 `rigged_choice` screen: non-Monika buttons dodge/pull toward Monika
          if (rigged && !label.toLowerCase().includes("monika")) {
            btn.style.transform = `translate(${(Math.random() - 0.5) * 260}px, ${(Math.random() - 0.5) * 120}px)`;
            btn.style.opacity = "0.65";
          }
        });

        btn.addEventListener("mouseleave", () => {
          btn.style.backgroundImage = `url("${idleBg}")`;
        });

        btn.addEventListener("click", () => {
          if (this.audio.isUnlocked()) {
            void this.audio
              .play("sfx", "gui/sfx/select.ogg", { loop: false })
              .catch(() => {});
          }
          this.hideChoices();
          resolve(idx);
        });

        this.choiceEl.appendChild(btn);
      });
    });
  }

  public waitForClick(): Promise<void> {
    this.clearTimers();
    this.isTyping = false;
    return new Promise<void>((resolve) => {
      this.advanceResolver = resolve;
    });
  }

  private handleAdvanceInput(): void {
    if (this.isTyping) {
      this.finishTyping();
      this.renderSpansUpTo(this.fullSpans, Number.MAX_SAFE_INTEGER);
      return;
    }
    this.resolveAdvance();
  }

  private finishTyping(): void {
    this.clearTimers();
    this.isTyping = false;
    this.ctcEl.classList.remove("is-hidden");
  }

  private resolveAdvance(): void {
    const resolver = this.advanceResolver;
    this.advanceResolver = null;
    if (resolver) {
      resolver();
    }
  }

  private setSpeaker(speaker: string | null): void {
    if (speaker && speaker.trim().length > 0) {
      this.nameboxEl.textContent = speaker;
      this.nameboxEl.classList.remove("is-hidden");
    } else {
      this.nameboxEl.textContent = "";
      this.nameboxEl.classList.add("is-hidden");
    }
  }

  private renderSpansUpTo(spans: TextSpan[], limit: number): void {
    this.textEl.innerHTML = "";
    let remaining = limit;

    for (const span of spans) {
      if (remaining <= 0) {
        break;
      }
      const slice = span.text.slice(0, remaining);
      remaining -= slice.length;

      const el = document.createElement("span");
      el.textContent = slice;
      if (span.style.italic) {
        el.style.fontStyle = "italic";
      }
      if (span.style.bold) {
        el.style.fontWeight = "700";
      }
      if (span.style.color) {
        el.style.color = span.style.color;
      }
      if (span.style.size) {
        el.style.fontSize = `${span.style.size}px`;
      }
      if (span.style.font) {
        el.style.fontFamily = span.style.font;
      }
      this.textEl.appendChild(el);
    }
  }

  private clearTimers(): void {
    if (this.typeTimer !== null) {
      window.clearInterval(this.typeTimer);
      this.typeTimer = null;
    }
    if (this.afmTimer !== null) {
      window.clearTimeout(this.afmTimer);
      this.afmTimer = null;
    }
  }

  public hide(): void {
    this.clearTimers();
    this.setSkipping(false);
    this.setAutoForward(false);
    this.isTyping = false;
    this.advanceResolver = null;
    this.layerEl.classList.add("is-hidden");
    this.choiceEl.classList.add("is-hidden");
    this.choiceEl.innerHTML = "";
  }

  public destroy(): void {
    this.hide();
    if (this.keyDownHandler) {
      window.removeEventListener("keydown", this.keyDownHandler);
      this.keyDownHandler = null;
    }
    if (this.keyUpHandler) {
      window.removeEventListener("keyup", this.keyUpHandler);
      this.keyUpHandler = null;
    }
    if (this.blurHandler) {
      window.removeEventListener("blur", this.blurHandler);
      this.blurHandler = null;
    }
    this.layerEl.remove();
    this.choiceEl.remove();
  }
}
