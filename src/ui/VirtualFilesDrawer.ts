import type { VirtualFS } from "../engine/VirtualFS";

/**
 * In-browser file explorer for DDLC's virtual `characters/` folder and
 * game-dropped secret files (so players can inspect, delete, or restore
 * `.chr` files without needing desktop filesystem access).
 */
export class VirtualFilesDrawer {
  private readonly backdrop: HTMLDivElement;
  private readonly listBody: HTMLDivElement;
  private readonly unsubscribe: () => void;

  public constructor(
    uiRoot: HTMLElement,
    private readonly vfs: VirtualFS,
  ) {
    this.backdrop = document.createElement("div");
    this.backdrop.className = "ddlc-vfs-backdrop is-hidden";

    const modal = document.createElement("div");
    modal.className = "ddlc-vfs-modal";

    const header = document.createElement("div");
    header.className = "ddlc-vfs-header";

    const title = document.createElement("h2");
    title.className = "ddlc-vfs-title";
    title.textContent = "DDLC Virtual Files (characters/)";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "ddlc-btn-small";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", () => this.hide());

    header.appendChild(title);
    header.appendChild(closeBtn);

    this.listBody = document.createElement("div");
    this.listBody.className = "ddlc-vfs-body";

    const footer = document.createElement("div");
    footer.className = "ddlc-vfs-footer";

    const note = document.createElement("span");
    note.textContent = "Changes persist in your browser and affect game events.";

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "ddlc-btn-small";
    resetBtn.textContent = "Reset All Files";
    resetBtn.addEventListener("click", () => {
      this.vfs.resetToInitial();
    });

    footer.appendChild(note);
    footer.appendChild(resetBtn);

    modal.appendChild(header);
    modal.appendChild(this.listBody);
    modal.appendChild(footer);
    this.backdrop.appendChild(modal);

    this.backdrop.addEventListener("click", (ev) => {
      if (ev.target === this.backdrop) {
        this.hide();
      }
    });

    uiRoot.appendChild(this.backdrop);
    this.unsubscribe = this.vfs.subscribe(() => this.render());
    this.render();
  }

  public show(): void {
    this.render();
    this.backdrop.classList.remove("is-hidden");
  }

  public hide(): void {
    this.backdrop.classList.add("is-hidden");
  }

  private render(): void {
    this.listBody.innerHTML = "";
    const entries = this.vfs.listAll();

    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ddlc-vfs-row";
      empty.textContent = "No virtual files available.";
      this.listBody.appendChild(empty);
      return;
    }

    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "ddlc-vfs-row";

      const info = document.createElement("div");
      const nameEl = document.createElement("div");
      nameEl.textContent = entry.path;
      nameEl.style.fontWeight = "700";
      if (!entry.present) {
        nameEl.style.textDecoration = "line-through";
        nameEl.style.opacity = "0.55";
      }

      const meta = document.createElement("div");
      meta.className = "ddlc-vfs-meta";
      meta.textContent = entry.present ? "Present" : "Deleted";

      info.appendChild(nameEl);
      info.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "ddlc-vfs-actions";

      if (entry.present && entry.sourceUrl) {
        const downloadLink = document.createElement("a");
        downloadLink.href = entry.sourceUrl;
        downloadLink.download = entry.path.split("/").pop() ?? "file";
        downloadLink.className = "ddlc-btn-small";
        downloadLink.style.textDecoration = "none";
        downloadLink.textContent = "Download";
        actions.appendChild(downloadLink);
      }

      if (entry.present) {
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "ddlc-btn-small ddlc-btn-danger";
        delBtn.textContent = "Delete";
        delBtn.addEventListener("click", () => {
          this.vfs.deleteFile(entry.path);
        });
        actions.appendChild(delBtn);
      } else {
        const restoreBtn = document.createElement("button");
        restoreBtn.type = "button";
        restoreBtn.className = "ddlc-btn-small";
        restoreBtn.textContent = "Restore";
        restoreBtn.addEventListener("click", () => {
          this.vfs.restoreFile(entry.path);
        });
        actions.appendChild(restoreBtn);
      }

      row.appendChild(info);
      row.appendChild(actions);
      this.listBody.appendChild(row);
    }
  }

  public destroy(): void {
    this.unsubscribe();
    this.backdrop.remove();
  }
}
