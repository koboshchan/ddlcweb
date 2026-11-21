const PERSISTENT_KEY = "ddlcweb:persistent:v2";
const SAVES_KEY = "ddlcweb:saves:v2";

export const SAVE_FORMAT_VERSION = 2;
export const QUICK_SAVE_SLOT = 0;

export interface PersistentPreferences {
  musicVolume: number;
  sfxVolume: number;
  textCps: number;
  autoForwardTime: number;
  skipUnseen: boolean;
  afmEnable: boolean;
}

export interface PersistentData {
  first_run: boolean;
  oldversion: string;
  anticheat: number;
  playthrough: number;
  playername: string;
  autoload: string;
  ghost_menu: boolean;
  seen_ghost_menu: boolean;
  seen_eyes: boolean;
  seen_sticker: boolean;
  first_poem: boolean;
  first_load: boolean;
  deleted_saves: boolean;
  yuri_kill: number;
  special_poems: number[] | null;
  monikatopics: number[];
  monika_reload: number;
  tried_skip: boolean | null;
  monika_kill: boolean;
  clear: boolean[];
  clearall: boolean;
  seenLabels: string[];
  seenLines: Record<string, true>;
  preferences: PersistentPreferences;
  [key: string]: unknown;
}

export interface HistoryEntry {
  who: string | null;
  what: string;
}

export type BlockPathSegment =
  | { kind: "if"; stmtIndex: number; branchIndex: number }
  | { kind: "menu"; stmtIndex: number; itemIndex: number }
  | { kind: "while"; stmtIndex: number }
  | { kind: "label"; stmtIndex: number };

export interface SavedFrame {
  label: string;
  blockPath: BlockPathSegment[];
  index: number;
  localScope?: Record<string, unknown>;
  isSubroutineBoundary?: boolean;
}

export interface SavedSpriteState {
  tag: string;
  imageName: string;
  layerName: string;
  at: string[];
  x: number;
  y: number;
  xcenter: number;
  ypos: number;
  yanchor: number;
  xoffset: number;
  yoffset: number;
  zoom: number;
  alpha: number;
  zorder: number;
  isTopLeftOverlay: boolean;
}

export interface SavedSceneState {
  bg: string | null;
  bgAt: string[];
  sprites: SavedSpriteState[];
  layerAt: Record<string, string[]>;
  music: string | null;
  dialogueStyle: string;
  quickMenuVisible: boolean;
  monikaTextbox: boolean;
}

export interface SaveSlot {
  version: number;
  slot: number;
  label: string;
  callStack: SavedFrame[];
  chapter: number;
  savedAt: string;
  caption: string;
  thumbnail: string;
  variables: Record<string, unknown>;
  sceneState: SavedSceneState;
  history?: HistoryEntry[];
}

const DEFAULT_PERSISTENT: PersistentData = {
  first_run: false,
  oldversion: "1.1.1",
  anticheat: 0,
  playthrough: 0,
  playername: "",
  autoload: "",
  ghost_menu: false,
  seen_ghost_menu: false,
  seen_eyes: false,
  seen_sticker: false,
  first_poem: false,
  first_load: false,
  deleted_saves: false,
  yuri_kill: 0,
  special_poems: null,
  monikatopics: [],
  monika_reload: 0,
  tried_skip: null,
  monika_kill: false,
  clear: [false, false, false, false, false, false, false, false, false, false],
  clearall: false,
  seenLabels: [],
  seenLines: {},
  preferences: {
    musicVolume: 0.8,
    sfxVolume: 0.9,
    textCps: 50,
    autoForwardTime: 5,
    skipUnseen: false,
    afmEnable: false,
  },
};

/**
 * Handles DDLC's `persistent` store, numbered + quick save slots,
 * per-line seen tracking, and dialogue history buffer in localStorage.
 */
export class Persistence {
  public data: PersistentData;
  private saves: Record<number, SaveSlot>;
  public history: HistoryEntry[] = [];

  public constructor() {
    this.data = this.loadPersistent();
    this.ensureSpecialPoems();
    this.saves = this.loadSaves();
  }

  public ensureSpecialPoems(): void {
    if (Array.isArray(this.data.special_poems) && this.data.special_poems.length >= 3) {
      return;
    }
    const pool = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const picked: number[] = [];
    for (let i = 0; i < 3; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      picked.push(pool.splice(idx, 1)[0]);
    }
    this.data.special_poems = picked;
    this.savePersistent();
  }

  private loadPersistent(): PersistentData {
    const raw = localStorage.getItem(PERSISTENT_KEY);
    if (!raw) {
      return structuredClone(DEFAULT_PERSISTENT);
    }
    try {
      const parsed = JSON.parse(raw) as Partial<PersistentData>;
      return {
        ...structuredClone(DEFAULT_PERSISTENT),
        ...parsed,
        seenLines: parsed.seenLines ?? {},
        preferences: {
          ...DEFAULT_PERSISTENT.preferences,
          ...(parsed.preferences ?? {}),
        },
      };
    } catch {
      return structuredClone(DEFAULT_PERSISTENT);
    }
  }

  private loadSaves(): Record<number, SaveSlot> {
    const raw = localStorage.getItem(SAVES_KEY);
    if (!raw) {
      return {};
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, SaveSlot>;
      const valid: Record<number, SaveSlot> = {};
      let droppedLegacy = false;
      for (const [k, slot] of Object.entries(parsed)) {
        if (slot && slot.version === SAVE_FORMAT_VERSION) {
          valid[Number(k)] = slot;
        } else {
          droppedLegacy = true;
        }
      }
      if (droppedLegacy) {
        localStorage.setItem(SAVES_KEY, JSON.stringify(valid));
      }
      return valid;
    } catch {
      return {};
    }
  }

  public savePersistent(): void {
    localStorage.setItem(PERSISTENT_KEY, JSON.stringify(this.data));
  }

  public markLabelSeen(label: string): void {
    if (!this.data.seenLabels.includes(label)) {
      this.data.seenLabels.push(label);
      this.savePersistent();
    }
  }

  public isLabelSeen(label: string): boolean {
    return this.data.seenLabels.includes(label);
  }

  public markLineSeen(lineKey: string): void {
    if (!this.data.seenLines[lineKey]) {
      this.data.seenLines[lineKey] = true;
      this.savePersistent();
    }
  }

  public isLineSeen(lineKey: string): boolean {
    return Boolean(this.data.seenLines[lineKey]);
  }

  public addHistory(who: string | null, what: string): void {
    this.history.push({ who, what });
    if (this.history.length > 50) {
      this.history.shift();
    }
  }

  public setHistory(entries: HistoryEntry[]): void {
    this.history = entries.slice(-50);
  }

  public writeSlot(slot: SaveSlot): void {
    this.saves[slot.slot] = slot;
    localStorage.setItem(SAVES_KEY, JSON.stringify(this.saves));
  }

  public readSlot(slotIndex: number): SaveSlot | null {
    const slot = this.saves[slotIndex];
    if (!slot || slot.version !== SAVE_FORMAT_VERSION) {
      return null;
    }
    return slot;
  }

  public listSlots(): SaveSlot[] {
    return Object.values(this.saves)
      .filter((s) => s.slot !== QUICK_SAVE_SLOT && s.version === SAVE_FORMAT_VERSION)
      .sort((a, b) => a.slot - b.slot);
  }

  public hasAnySave(): boolean {
    return Object.values(this.saves).some(
      (s) => s.version === SAVE_FORMAT_VERSION,
    );
  }

  public clearAllSaves(): void {
    this.saves = {};
    this.data.deleted_saves = true;
    localStorage.removeItem(SAVES_KEY);
    this.savePersistent();
  }

  public resetPersistent(): void {
    this.data = structuredClone(DEFAULT_PERSISTENT);
    this.ensureSpecialPoems();
    this.savePersistent();
  }
}
