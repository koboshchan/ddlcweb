const STORAGE_KEY = "ddlcweb:vfs:v1";

export interface VirtualFileEntry {
  path: string;
  present: boolean;
  sourceUrl?: string;
  textContent?: string;
  updatedAt: number;
}

interface StoredVfsState {
  files: Record<string, VirtualFileEntry>;
}

/**
 * Browser-native virtual filesystem emulating DDLC's `characters/` directory
 * and game-root files (`CAN YOU HEAR ME.txt`, `hxppy thxughts.png`, etc.).
 * Persists deletions and additions in localStorage so Act 2/3/4 `.chr` file
 * checks work identically to the desktop release.
 */
export class VirtualFS {
  private readonly files = new Map<string, VirtualFileEntry>();
  private readonly initialCharacters: string[];
  private readonly listeners = new Set<() => void>();

  public constructor(characterFiles: string[]) {
    this.initialCharacters = [...characterFiles];
    this.load();
  }

  private load(): void {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as StoredVfsState;
        if (parsed && parsed.files) {
          for (const [path, entry] of Object.entries(parsed.files)) {
            this.files.set(path, entry);
          }
          return;
        }
      } catch {
        // Fall through to clean seed on corrupt storage.
      }
    }
    this.resetToInitial();
  }

  private save(): void {
    const obj: Record<string, VirtualFileEntry> = {};
    for (const [path, entry] of this.files.entries()) {
      obj[path] = entry;
    }
    const payload: StoredVfsState = { files: obj };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public resetToInitial(): void {
    this.files.clear();
    const now = Date.now();
    for (const name of this.initialCharacters) {
      const path = `characters/${name}`;
      this.files.set(path, {
        path,
        present: true,
        sourceUrl: `./game-assets/characters/${encodeURIComponent(name)}`,
        updatedAt: now,
      });
    }
    this.save();
  }

  public exists(path: string): boolean {
    const entry = this.files.get(path);
    return entry !== undefined && entry.present;
  }

  public deleteFile(path: string): void {
    const entry = this.files.get(path);
    if (!entry) {
      return;
    }
    entry.present = false;
    entry.updatedAt = Date.now();
    this.save();
  }

  public restoreFile(path: string): void {
    const entry = this.files.get(path);
    if (!entry) {
      return;
    }
    entry.present = true;
    entry.updatedAt = Date.now();
    this.save();
  }

  public writeTextFile(path: string, content: string): void {
    this.files.set(path, {
      path,
      present: true,
      textContent: content,
      updatedAt: Date.now(),
    });
    this.save();
  }

  public writeAssetFile(path: string, sourceUrl: string): void {
    this.files.set(path, {
      path,
      present: true,
      sourceUrl,
      updatedAt: Date.now(),
    });
    this.save();
  }

  public listAll(): VirtualFileEntry[] {
    return Array.from(this.files.values()).sort((a, b) =>
      a.path.localeCompare(b.path),
    );
  }
}
