import type { AssetLoader } from "../engine/AssetLoader";
import type { AudioEngine } from "../engine/AudioEngine";

/**
 * DDLC modal screens (`name_input`, `dialog`, `confirm`, first-run ToS,
 * `notify` toast, and `skip_indicator`).
 */
export class ModalScreens {
  private readonly layerEl: HTMLDivElement;
  private readonly skipBadgeEl: HTMLDivElement;
  private readonly notifyEl: HTMLDivElement;
  private notifyTimer: number | null = null;

  public constructor(
    uiRoot: HTMLElement,
    private readonly assets: AssetLoader,
    private readonly audio: AudioEngine,
  ) {
    this.layerEl = document.createElement("div");
    this.layerEl.className = "ddlc-modal-layer is-hidden";

    this.skipBadgeEl = document.createElement("div");
    this.skipBadgeEl.className = "ddlc-skip-indicator is-hidden";
    this.skipBadgeEl.style.backgroundImage = `url("${this.assets.getAssetUrl("gui/skip.png")}")`;
    this.skipBadgeEl.textContent = "Skipping ▸▸";

    this.notifyEl = document.createElement("div");
    this.notifyEl.className = "ddlc-notify is-hidden";
    this.notifyEl.style.backgroundImage = `url("${this.assets.getAssetUrl("gui/notify.png")}")`;

    uiRoot.appendChild(this.skipBadgeEl);
    uiRoot.appendChild(this.notifyEl);
    uiRoot.appendChild(this.layerEl);
  }

  public setSkipIndicator(visible: boolean): void {
    this.skipBadgeEl.classList.toggle("is-hidden", !visible);
  }

  public showNotify(message: string): void {
    if (this.notifyTimer !== null) {
      window.clearTimeout(this.notifyTimer);
    }
    this.notifyEl.textContent = message;
    this.notifyEl.classList.remove("is-hidden");
    this.notifyTimer = window.setTimeout(() => {
      this.notifyEl.classList.add("is-hidden");
    }, 3200);
  }

  public showNameInput(
    message = "Please enter your name",
    initialValue = "",
  ): Promise<string | null> {
    return new Promise((resolve) => {
      this.layerEl.innerHTML = "";
      this.layerEl.classList.remove("is-hidden");

      const frame = document.createElement("div");
      frame.className = "ddlc-confirm-frame";

      const prompt = document.createElement("div");
      prompt.className = "ddlc-confirm-prompt";
      prompt.textContent = message;

      const input = document.createElement("input");
      input.type = "text";
      input.id = "ddlc-player-name-input";
      input.name = "playername";
      input.maxLength = 12;
      input.className = "ddlc-name-input";
      input.value = initialValue;
      input.placeholder = "Player";

      const actions = document.createElement("div");
      actions.className = "ddlc-confirm-actions";

      const okBtn = this.makeConfirmButton("OK", () => {
        const val = input.value.trim();
        if (!val) {
          input.focus();
          return;
        }
        this.closeModal();
        resolve(val);
      });

      const cancelBtn = this.makeConfirmButton("Cancel", () => {
        this.closeModal();
        resolve(null);
      });

      actions.appendChild(okBtn);
      actions.appendChild(cancelBtn);

      frame.appendChild(prompt);
      frame.appendChild(input);
      frame.appendChild(actions);
      this.layerEl.appendChild(frame);

      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          okBtn.click();
        } else if (ev.key === "Escape") {
          ev.preventDefault();
          cancelBtn.click();
        }
      });

      window.setTimeout(() => input.focus(), 20);
    });
  }

  public showDialog(message: string, okText = "OK"): Promise<void> {
    return new Promise((resolve) => {
      this.layerEl.innerHTML = "";
      this.layerEl.classList.remove("is-hidden");

      const frame = document.createElement("div");
      frame.className = "ddlc-confirm-frame";

      const prompt = document.createElement("div");
      prompt.className = "ddlc-confirm-prompt";
      prompt.textContent = message;

      const actions = document.createElement("div");
      actions.className = "ddlc-confirm-actions";
      actions.appendChild(
        this.makeConfirmButton(okText, () => {
          this.closeModal();
          resolve();
        }),
      );

      frame.appendChild(prompt);
      frame.appendChild(actions);
      this.layerEl.appendChild(frame);
    });
  }

  public showConfirm(
    message: string,
    yesText = "Yes",
    noText = "No",
    glitched = false,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      this.layerEl.innerHTML = "";
      this.layerEl.classList.remove("is-hidden");

      if (glitched) {
        const glitchOverlay = document.createElement("div");
        glitchOverlay.className = "ddlc-confirm-glitch";
        glitchOverlay.style.backgroundImage = `url("${this.assets.getAssetUrl("gui/overlay/confirm_glitch.png")}")`;
        this.layerEl.appendChild(glitchOverlay);
      }

      const frame = document.createElement("div");
      frame.className = "ddlc-confirm-frame";

      const prompt = document.createElement("div");
      prompt.className = "ddlc-confirm-prompt";
      prompt.textContent = message;

      const actions = document.createElement("div");
      actions.className = "ddlc-confirm-actions";
      actions.appendChild(
        this.makeConfirmButton(yesText, () => {
          this.closeModal();
          resolve(true);
        }),
      );
      actions.appendChild(
        this.makeConfirmButton(noText, () => {
          this.closeModal();
          resolve(false);
        }),
      );

      frame.appendChild(prompt);
      frame.appendChild(actions);
      this.layerEl.appendChild(frame);
    });
  }

  public showTermsOfService(): Promise<void> {
    return this.showDialog(
      "This game is not suitable for children\nor those who are easily disturbed.\n\n" +
        "Individuals suffering from anxiety or depression may not have\n" +
        "a safe experience playing this game.\n\n" +
        "By playing Doki Doki Literature Club, you agree that you are at least\n" +
        "13 years of age, and you consent to your exposure of highly disturbing content.",
      "I agree.",
    );
  }

  private makeConfirmButton(
    label: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ddlc-nav-btn ddlc-confirm-btn";
    btn.textContent = label;
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
      onClick();
    });
    return btn;
  }

  private closeModal(): void {
    this.layerEl.classList.add("is-hidden");
    this.layerEl.innerHTML = "";
  }
}
