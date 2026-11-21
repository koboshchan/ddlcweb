import type { AssetLoader } from "../engine/AssetLoader";
import type { PoemDef } from "../types/game-data";

/**
 * Renders DDLC's `screen poem` with exact paper backgrounds (`paper`,
 * `paper_y1`, `paper_y2`), character handwriting fonts (`s1`, `n1`, `y1`,
 * `y2`, `y3`, `m1`), and scrollable `720px` viewport.
 */
export class PoemViewScreen {
  private readonly root: HTMLDivElement;
  private readonly paperEl: HTMLDivElement;
  private readonly titleEl: HTMLDivElement;
  private readonly bodyEl: HTMLDivElement;
  private dismissResolver: (() => void) | null = null;

  public constructor(
    uiRoot: HTMLElement,
    private readonly assets: AssetLoader,
  ) {
    this.root = document.createElement("div");
    this.root.className = "ddlc-poem-layer is-hidden";

    this.paperEl = document.createElement("div");
    this.paperEl.className = "ddlc-poem-paper";

    const viewport = document.createElement("div");
    viewport.className = "ddlc-poem-viewport";

    this.titleEl = document.createElement("div");
    this.titleEl.className = "ddlc-poem-title";

    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "ddlc-poem-body";

    viewport.appendChild(this.titleEl);
    viewport.appendChild(this.bodyEl);
    this.paperEl.appendChild(viewport);

    this.root.appendChild(this.paperEl);

    this.root.addEventListener("click", () => {
      if (this.dismissResolver) {
        const res = this.dismissResolver;
        this.dismissResolver = null;
        res();
      }
    });

    uiRoot.appendChild(this.root);
  }

  public show(
    poem: PoemDef,
    paper = "paper",
    _showDismissHint = false,
  ): void {
    const paperPath =
      paper === "paper_y1" || paper === "images/bg/poem_y1.jpg"
        ? "images/bg/poem_y1.jpg"
        : paper === "paper_y2" || paper === "images/bg/poem_y2.jpg"
          ? "images/bg/poem_y2.jpg"
          : paper === "paper_glitch" || paper === "images/bg/poem-glitch1.png"
            ? "images/bg/poem-glitch1.png"
            : "images/bg/poem.jpg";

    this.paperEl.style.backgroundImage = `url("${this.assets.getAssetUrl(paperPath)}")`;

    let styleClass = "ddlc-poem--sayori";
    if (poem.author === "natsuki") {
      styleClass = "ddlc-poem--natsuki";
    } else if (poem.author === "monika") {
      styleClass = "ddlc-poem--monika";
    } else if (poem.author === "yuri") {
      if (poem.yuri_3) {
        styleClass = "ddlc-poem--yuri3";
      } else if (poem.yuri_2) {
        styleClass = "ddlc-poem--yuri2";
      } else {
        styleClass = "ddlc-poem--yuri1";
      }
    }

    this.paperEl.className = `ddlc-poem-paper ${styleClass}`;
    this.titleEl.textContent = poem.title;
    this.bodyEl.textContent = poem.text;
    this.paperEl.scrollTop = 0;

    this.root.classList.remove("is-hidden");
  }

  public waitForDismiss(): Promise<void> {
    return new Promise((resolve) => {
      this.dismissResolver = resolve;
    });
  }

  public isOpen(): boolean {
    return !this.root.classList.contains("is-hidden");
  }

  public hide(): void {
    this.dismissResolver = null;
    this.root.classList.add("is-hidden");
  }
}
