const PERSISTENT_KEY = "ddlcweb:persistent:v2";
const SAVES_KEY = "ddlcweb:saves:v2";

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
  preferences: PersistentPreferences;
  [key: string]: unknown;
}

export interface HistoryEntry {
  who: string | null;
  what: string;
}

export interface SaveSlot {
  slot: number;
  label: string;
  callStack: Array<{ label: string; index: number; locals?: Record<string, unknown> }>;
  chapter: number;
  savedAt: string;
  caption: string;
  thumbnail: string;
  variables: Record<string, unknown>;
  sceneState: {
    bg: string | null;
    sprites: Array<{ tag: string; imageName: string; at: string[] }>;
    music: string | null;
  };
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
 * Handles DDLC's `persistent` store, numbered save slots, seen-label tracking,
 * and dialogue history buffer in localStorage.
 */
export class Persistence {
  public data: PersistentData;
  private saves: Record<number, SaveSlot>;
  public history: HistoryEntry[] = [];

  public constructor() {
    this.data = this.loadPersistent();
    this.saves = this.loadSaves();
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
      return JSON.parse(raw) as Record<number, SaveSlot>;
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

  public addHistory(who: string | null, what: string): void {
    this.history.push({ who, what });
    if (this.history.length > 50) {
      this.history.shift();
    }
  }

  public writeSlot(slot: SaveSlot): void {
    this.saves[slot.slot] = slot;
    localStorage.setItem(SAVES_KEY, JSON.stringify(this.saves));
  }

  public readSlot(slotIndex: number): SaveSlot | null {
    return this.saves[slotIndex] ?? null;
  }

  public listSlots(): SaveSlot[] {
    return Object.values(this.saves).sort((a, b) => a.slot - b.slot);
  }

  public hasAnySave(): boolean {
    return Object.keys(this.saves).length > 0;
  }

  public clearAllSaves(): void {
    this.saves = {};
    this.data.deleted_saves = true;
    localStorage.removeItem(SAVES_KEY);
    this.savePersistent();
  }

  public resetPersistent(): void {
    this.data = structuredClone(DEFAULT_PERSISTENT);
    this.savePersistent();
  }
}
