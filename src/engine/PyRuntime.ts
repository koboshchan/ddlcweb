import type {
  DefaultDef,
  PoemDef,
  PyExprNode,
  PyStmtNode,
} from "../types/game-data";
import type { AudioChannelName, AudioEngine } from "./AudioEngine";
import type { Persistence } from "./Persistence";
import type { SceneManager } from "./SceneManager";
import type { VirtualFS } from "./VirtualFS";

const GLITCH_CHARS =
  "¡¢£¤¥¦§¨©ª«¬®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿĀāĂăĄąĆćĈĉĊċČčĎďĐđĒēĔĕĖėĘęĚěĜĝĞğĠġĢģĤĥĦħĨĩĪīĬĭĮįİıĲĳĴĵĶķĸĹĺĻļĽľĿŀŁłŃńŅņŇňŉŊŋŌōŎŏŐőŒœŔŕŖŗŘřŚśŜŝŞşŠšŢţŤťŦŧŨũŪūŬŭŮůŰűŲųŴŵŶŷŸŹźŻżŽž";

export function glitchtext(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += GLITCH_CHARS[Math.floor(Math.random() * GLITCH_CHARS.length)];
  }
  return out;
}

export class JumpSignal {
  public constructor(public readonly target: string) {}
}

export class RestartSignal {
  public constructor(public readonly label?: string) {}
}

class ReturnSignal {
  public constructor(public readonly value: unknown) {}
}

class BreakSignal {}
class ContinueSignal {}

export interface PyRuntimeCallbacks {
  pause: (seconds?: number | null) => Promise<void>;
  callScreen: (name: string, args: unknown[], kwargs: Record<string, unknown>) => Promise<unknown>;
  showScreen: (name: string, args: unknown[], kwargs: Record<string, unknown>) => void;
  hideScreen: (name: string) => void;
  displayMenu: (items: Array<[string, unknown]>, interact?: boolean) => Promise<unknown>;
  setDialogueStyle: (styleName: string) => void;
  setQuickMenu: (visible: boolean) => void;
  setAllowSkipping?: (allowed: boolean) => void;
  runPoemGame: () => Promise<void>;
}

/**
 * Executes compiled DDLC `pyAst` expressions and statement blocks asynchronously
 * with full Ren'Py API, persistent storage, VirtualFS, and AudioEngine bindings.
 */
export class PyRuntime {
  public readonly globals = new Map<string, unknown>();
  private readonly functions = new Map<
    string,
    (args: unknown[], kwargs: Record<string, unknown>) => Promise<unknown> | unknown
  >();
  private readonly scopeStack: Array<Map<string, unknown>> = [];
  private transformNames = new Set<string>();

  public setTransformNames(names: Iterable<string>): void {
    this.transformNames = new Set(names);
  }

  public constructor(
    private readonly defaults: DefaultDef[],
    private readonly poems: Record<string, PoemDef>,
    private readonly persistence: Persistence,
    private readonly vfs: VirtualFS,
    private readonly audio: AudioEngine,
    private readonly scene: SceneManager,
    private readonly callbacks: PyRuntimeCallbacks,
  ) {
    this.reset();
  }

  public reset(): void {
    this.globals.clear();
    this.scopeStack.length = 0;

    // Seed static defaults from compiled .rpyc files
    for (const def of this.defaults) {
      if (def.store && def.store !== "store") {
        continue;
      }
      if (def.ast) {
        try {
          this.globals.set(def.varname, this.evalExprSync(def.ast));
        } catch {
          this.globals.set(def.varname, null);
        }
      }
    }

    // Seed Poems from poems.rpyc
    for (const [id, poem] of Object.entries(this.poems)) {
      this.globals.set(id, { ...poem });
    }

    // Core runtime namespaces
    this.globals.set("True", true);
    this.globals.set("False", false);
    this.globals.set("None", null);
    this.globals.set("player", this.persistence.data.playername || "MC");
    this.globals.set("basedir", "/");
    this.globals.set("quick_menu", true);
    this.globals.set("allow_skipping", true);
    this.globals.set("_dismiss_pause", false);
    this.globals.set("currentuser", "Player");
    this.globals.set("consolehistory", []);
    this.globals.set("consolehistorydisplay", "");
    this.globals.set("splash_message", "This game is not suitable for children\nor those who are easily disturbed.");
    this.globals.set(
      "splash_message_default",
      "This game is not suitable for children\nor those who are easily disturbed.",
    );
    this.globals.set("splash_messages", [
      "You are my sunshine,\nMy only sunshine",
      "I missed you.",
      "Play with me",
      "It's just a game, mostly.",
      "This game is not suitable for children\nor those who are easily disturbed?",
      "sdfasdklfgsdfgsgoinrfoenlvbd",
      "null",
      "I have granted kids to hell",
      "PM died for this.",
      "It was only partially your fault.",
      "This game is not suitable for children\nor those who are easily dismembered.",
      "Don't forget to backup Monika's character file.",
    ]);
    this.globals.set("menu_trans_time", 1);
    this.globals.set("firstrun", "1");
    this.globals.set("process_list", []);
    this.globals.set("_history_list", this.persistence.history);

    this.globals.set("config", {
      basedir: "",
      version: "1.1.1",
      developer: false,
      allow_skipping: true,
      skipping: false,
      main_menu_music: "t1",
      keymap: { game_menu: [], hide_windows: [] },
    });

    this.globals.set("style", {
      say_dialogue: "normal",
      normal: "normal",
      edited: "edited",
      default_monika: "default_monika",
    });

    this.globals.set("gui", {
      activate_sound: "gui/sfx/select.ogg",
      activate_sound_glitch: "gui/sfx/select_glitch.ogg",
      hover_sound: "gui/sfx/hover.ogg",
    });

    this.installBuiltins();
  }

  public pushScope(vars: Record<string, unknown> = {}): Map<string, unknown> {
    const map = new Map<string, unknown>();
    for (const [k, v] of Object.entries(vars)) {
      map.set(k, v);
    }
    this.scopeStack.push(map);
    return map;
  }

  public popScope(): void {
    this.scopeStack.pop();
  }

  public clearScopes(): void {
    this.scopeStack.length = 0;
  }

  public exportScope(scopeMap: Map<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of scopeMap.entries()) {
      const cloned = toJsonSafeValue(v);
      if (cloned !== undefined) {
        out[k] = cloned;
      }
    }
    return out;
  }

  public getVar(name: string): unknown {
    if (name === "persistent") {
      return this.persistence.data;
    }
    if (name === "audio") {
      return this.createAudioProxy();
    }
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      if (this.scopeStack[i].has(name)) {
        return this.scopeStack[i].get(name);
      }
    }
    return this.globals.get(name);
  }

  public setVar(name: string, value: unknown): void {
    if (name === "quick_menu") {
      this.callbacks.setQuickMenu(Boolean(value));
    }
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      if (this.scopeStack[i].has(name)) {
        this.scopeStack[i].set(name, value);
        return;
      }
    }
    this.globals.set(name, value);
  }

  public exportVars(): Record<string, unknown> {
    const skipGlobals = new Set([
      "config",
      "renpy",
      "random",
      "datetime",
      "os",
      "m",
      "gui",
      "style",
      "_history_list",
    ]);
    const out: Record<string, unknown> = {};
    for (const [k, v] of this.globals.entries()) {
      if (skipGlobals.has(k)) {
        continue;
      }
      const cloned = toJsonSafeValue(v);
      if (cloned !== undefined) {
        out[k] = cloned;
      }
    }
    return out;
  }

  public importVars(vars: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(vars)) {
      this.globals.set(k, structuredClone(v));
    }
  }

  private createAudioProxy(): Record<string, unknown> {
    return new Proxy(
      {},
      {
        get: (_target, prop: string) => this.audio.getAliasRaw(prop) ?? prop,
        set: (_target, prop: string, value: unknown) => {
          if (typeof value === "string") {
            this.audio.setAlias(prop, value);
          }
          return true;
        },
      },
    );
  }

  private installBuiltins(): void {
    const fns = this.functions;

    fns.set("str", (args) => String(args[0] ?? ""));
    fns.set("int", (args) => parseInt(String(args[0] ?? 0), 10) || 0);
    fns.set("float", (args) => parseFloat(String(args[0] ?? 0)) || 0);
    fns.set("len", (args) => {
      const x = args[0];
      if (typeof x === "string" || Array.isArray(x)) {
        return x.length;
      }
      if (x && typeof x === "object") {
        return Object.keys(x).length;
      }
      return 0;
    });
    fns.set("list", (args) => (Array.isArray(args[0]) ? [...args[0]] : []));
    fns.set("set", (args) => new Set(Array.isArray(args[0]) ? args[0] : []));
    fns.set("range", (args) => {
      const start = args.length > 1 ? Number(args[0]) : 0;
      const stop = args.length > 1 ? Number(args[1]) : Number(args[0]);
      const out: number[] = [];
      for (let i = start; i < stop; i++) {
        out.push(i);
      }
      return out;
    });
    fns.set("max", (args) => Math.max(...args.map(Number)));
    fns.set("min", (args) => Math.min(...args.map(Number)));
    fns.set("sorted", (args, kwargs) => {
      const arr = Array.isArray(args[0])
        ? [...args[0]]
        : args[0] && typeof args[0] === "object"
          ? Object.keys(args[0] as Record<string, unknown>)
          : [];
      const keyObj = kwargs.key as ((k: unknown) => number) | undefined;
      if (keyObj) {
        arr.sort((a, b) => Number(keyObj(a)) - Number(keyObj(b)));
      } else {
        arr.sort();
      }
      return arr;
    });
    fns.set("all", (args) => {
      const iter = Array.isArray(args[0]) ? args[0] : [];
      return iter.every(Boolean);
    });
    fns.set("globals", () => Object.fromEntries(this.globals.entries()));

    fns.set("glitchtext", (args) => glitchtext(Number(args[0] ?? 10)));
    fns.set("Return", (args) => args[0] ?? true);
    fns.set("Dissolve", (args) => Number(args[0] ?? 0.25));
    fns.set("pause", async (args) => {
      const t = args[0] === undefined || args[0] === null ? null : Number(args[0]);
      await this.callbacks.pause(t);
    });
    fns.set("_window_hide", async () => {});

    fns.set("get_pos", (args) => {
      const ch = (args[0] as AudioChannelName | undefined) ?? "music";
      return this.audio.getPosition(ch);
    });

    fns.set("delete_character", (args) => {
      const name = String(args[0] ?? "");
      this.vfs.deleteFile(`characters/${name}.chr`);
    });

    fns.set("restore_all_characters", () => {
      for (const name of ["monika", "natsuki", "yuri", "sayori"]) {
        this.vfs.restoreFile(`characters/${name}.chr`);
      }
    });

    fns.set("restore_relevant_characters", () => {
      for (const name of ["monika", "natsuki", "yuri", "sayori"]) {
        this.vfs.restoreFile(`characters/${name}.chr`);
      }
      const pt = this.persistence.data.playthrough;
      if (pt === 1 || pt === 2) {
        this.vfs.deleteFile("characters/sayori.chr");
      } else if (pt === 3) {
        this.vfs.deleteFile("characters/sayori.chr");
        this.vfs.deleteFile("characters/natsuki.chr");
        this.vfs.deleteFile("characters/yuri.chr");
      } else if (pt === 4) {
        this.vfs.deleteFile("characters/monika.chr");
      }
    });

    fns.set("delete_all_saves", () => {
      this.persistence.clearAllSaves();
    });

    fns.set("open", (args) => {
      const rawPath = String(args[0] ?? "").replace(/^\/+/, "");
      const mode = String(args[1] ?? "r");
      if (mode.includes("w")) {
        return {
          write: (data: unknown) => {
            if (typeof data === "string") {
              this.vfs.writeTextFile(rawPath, data);
            } else if (data && typeof data === "object" && "sourceUrl" in data) {
              this.vfs.writeAssetFile(
                rawPath,
                String((data as { sourceUrl: string }).sourceUrl),
              );
            } else {
              this.vfs.writeTextFile(rawPath, String(data ?? ""));
            }
          },
          close: () => {},
        };
      }
      if (!this.vfs.exists(rawPath)) {
        throw new Error(`FileNotFoundError: ${rawPath}`);
      }
      return {
        read: () => "",
        close: () => {},
      };
    });

    fns.set("eval", (args) => {
      const expr = String(args[0] ?? "").trim();
      return this.getVar(expr) ?? expr;
    });

    fns.set("exec", (args) => {
      const code = String(args[0] ?? "").trim();
      const plusEq = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*\+=\s*(.+)$/.exec(code);
      if (plusEq) {
        const cur = Number(this.getVar(plusEq[1]) ?? 0);
        const delta = Number(plusEq[2]);
        this.setVar(plusEq[1], cur + delta);
        return;
      }
      const subEq = /^([a-zA-Z_][a-zA-Z0-9_]*)\[([a-zA-Z0-9_]+)\]\s*=\s*(.+)$/.exec(code);
      if (subEq) {
        const arr = this.getVar(subEq[1]);
        const idx = Number(this.getVar(subEq[2]) ?? subEq[2]);
        const val = Number(subEq[3]);
        if (Array.isArray(arr)) {
          arr[idx] = val;
        }
      }
    });

    fns.set("Poem", (_args, kwargs) => ({ ...kwargs }));

    // Namespaces
    const randomNs = {
      randint: (a: number, b: number) =>
        Math.floor(Math.random() * (b - a + 1)) + a,
      random: () => Math.random(),
      choice: <T>(arr: T[]): T =>
        arr[Math.floor(Math.random() * arr.length)],
    };
    this.globals.set("random", randomNs);

    const makeNow = () => {
      const nowMs = Date.now();
      return {
        _ms: nowMs,
        microseconds: (nowMs % 1000) * 1000,
        total_seconds: () => nowMs / 1000,
      };
    };
    this.globals.set("datetime", {
      datetime: { now: makeNow },
    });

    this.globals.set("os", {
      remove: (rawPath: string) => {
        const clean = rawPath.replace(/^\/+/, "");
        this.vfs.deleteFile(clean);
      },
      environ: { get: () => "" },
    });

    this.globals.set("renpy", {
      windows: false,
      random: randomNs,
      save_persistent: () => this.persistence.savePersistent(),
      file: (rawPath: string) => {
        const clean = rawPath
          .replace(/^\.\.\//, "")
          .replace(/^\/+/, "");
        if (clean.startsWith("characters/")) {
          if (!this.vfs.exists(clean)) {
            throw new Error(`IOError: ${clean} missing`);
          }
          return {
            read: () => ({ sourceUrl: `./game-assets/${clean}` }),
          };
        }
        return {
          read: () => ({ sourceUrl: `./game-assets/game/${clean}` }),
        };
      },
      show: async (name: string, kwargs?: Record<string, unknown>) => {
        const atList = Array.isArray(kwargs?.at_list)
          ? kwargs.at_list.filter(
              (x): x is string => typeof x === "string" && x.trim().length > 0,
            )
          : [];
        await this.scene.show(name, atList);
      },
      hide: async (name: string) => {
        await this.scene.hide(name);
      },
      scene: async () => {
        await this.scene.setScene("white");
      },
      play: async (soundPath: string) => {
        await this.audio.play("sfx", soundPath, { loop: false }).catch(() => {});
      },
      jump: (target: string) => {
        throw new JumpSignal(target);
      },
      quit: () => {
        throw new RestartSignal();
      },
      utter_restart: () => {
        throw new RestartSignal();
      },
      full_restart: (kwargs?: Record<string, unknown>) => {
        throw new RestartSignal(
          kwargs?.label ? String(kwargs.label) : undefined,
        );
      },
      pop_call: () => {},
      block_rollback: () => {},
      context: () => ({ _menu: false, _main_menu: false }),
      display: {
        behavior: { clear_keymap_cache: () => {} },
      },
      loadsave: {
        location: {
          unlink_persistent: () => this.persistence.resetPersistent(),
        },
      },
      persistent: { should_save_persistent: true },
      game: { preferences: this.persistence.data.preferences },
      call_screen: async (
        name: string,
        ...rawArgs: unknown[]
      ) => {
        let posArgs = rawArgs;
        let kwargs: Record<string, unknown> = {};
        const last = rawArgs[rawArgs.length - 1];
        if (
          rawArgs.length > 0 &&
          last !== null &&
          typeof last === "object" &&
          !Array.isArray(last) &&
          !("author" in last && "title" in last)
        ) {
          posArgs = rawArgs.slice(0, -1);
          kwargs = last as Record<string, unknown>;
        }
        return this.callbacks.callScreen(name, posArgs, kwargs);
      },
      display_menu: async (...callArgs: unknown[]) => {
        let items: Array<[string, unknown]> = [];
        let interact = true;
        if (Array.isArray(callArgs[0])) {
          items = callArgs[0] as Array<[string, unknown]>;
          const kw = callArgs[1] as Record<string, unknown> | undefined;
          if (kw && kw.interact === false) {
            interact = false;
          }
        } else if (callArgs[0] && typeof callArgs[0] === "object") {
          const kw = callArgs[0] as Record<string, unknown>;
          if (Array.isArray(kw.items)) {
            items = kw.items as Array<[string, unknown]>;
          }
          if (kw.interact === false) {
            interact = false;
          }
        }
        return this.callbacks.displayMenu(items, interact);
      },
      music: {
        register_channel: () => {},
        get_pos: (kwargs?: Record<string, unknown>) =>
          this.audio.getPosition((kwargs?.channel as AudioChannelName) ?? "music"),
        get_playing: (kwargs?: Record<string, unknown>) =>
          this.audio.getPlaying((kwargs?.channel as AudioChannelName) ?? "music"),
        play: async (track: string, kwargs?: Record<string, unknown>) => {
          const ch = (kwargs?.channel as AudioChannelName) ?? "music";
          const fadein = typeof kwargs?.fadein === "number" ? kwargs.fadein : 0;
          await this.audio.play(ch, track, { fadein }).catch(() => {});
        },
        stop: (kwargs?: Record<string, unknown>) => {
          const ch = (kwargs?.channel as AudioChannelName) ?? "music";
          const fadeout = typeof kwargs?.fadeout === "number" ? kwargs.fadeout : 0;
          this.audio.stop(ch, fadeout);
        },
      },
    });

    this.globals.set("m", {
      add_history: (
        _kind: string,
        who: string,
        what: string,
      ) => {
        this.persistence.addHistory(who, what);
      },
    });
  }

  public async execBlock(stmts: PyStmtNode[]): Promise<unknown> {
    for (const stmt of stmts) {
      const res = await this.execStmt(stmt);
      if (res instanceof ReturnSignal) {
        return res;
      }
      if (res instanceof BreakSignal || res instanceof ContinueSignal) {
        return res;
      }
    }
    return undefined;
  }

  private async execStmt(stmt: PyStmtNode): Promise<unknown> {
    switch (stmt.t) {
      case "pass":
      case "noop":
      case "global":
      case "import":
        return undefined;

      case "expr": {
        await this.evalExpr(stmt.val);
        return undefined;
      }

      case "assign": {
        const val = await this.evalExpr(stmt.val);
        for (const tgt of stmt.targets) {
          await this.assignTarget(tgt, val);
        }
        if (stmt.targets[0]?.t === "attr") {
          const obj = stmt.targets[0].obj;
          if (obj.t === "name" && obj.id === "style" && stmt.targets[0].attr === "say_dialogue") {
            this.callbacks.setDialogueStyle(String(val));
          }
        }
        return undefined;
      }

      case "aug": {
        const cur = Number((await this.evalExpr(stmt.target)) ?? 0);
        const delta = Number((await this.evalExpr(stmt.val)) ?? 0);
        let next = cur;
        if (stmt.op === "+=") {
          next = cur + delta;
        } else if (stmt.op === "-=") {
          next = cur - delta;
        } else if (stmt.op === "*=") {
          next = cur * delta;
        } else if (stmt.op === "/=") {
          next = delta !== 0 ? cur / delta : 0;
        }
        await this.assignTarget(stmt.target, next);
        return undefined;
      }

      case "if": {
        const cond = Boolean(await this.evalExpr(stmt.test));
        if (cond) {
          return this.execBlock(stmt.body);
        }
        return this.execBlock(stmt.else);
      }

      case "while": {
        let guard = 0;
        while (Boolean(await this.evalExpr(stmt.test))) {
          guard += 1;
          if (guard > 2000) {
            break;
          }
          const res = await this.execBlock(stmt.body);
          if (res instanceof BreakSignal) {
            break;
          }
          if (res instanceof ReturnSignal) {
            return res;
          }
        }
        return undefined;
      }

      case "for": {
        const iter = await this.evalExpr(stmt.iter);
        const arr = Array.isArray(iter) ? iter : [];
        for (const item of arr) {
          await this.assignTarget(stmt.target, item);
          const res = await this.execBlock(stmt.body);
          if (res instanceof BreakSignal) {
            break;
          }
          if (res instanceof ReturnSignal) {
            return res;
          }
        }
        return undefined;
      }

      case "try": {
        try {
          return await this.execBlock(stmt.body);
        } catch (err) {
          if (err instanceof JumpSignal || err instanceof RestartSignal) {
            throw err;
          }
          if (stmt.handlers.length > 0) {
            return await this.execBlock(stmt.handlers[0]);
          }
        }
        return undefined;
      }

      case "del": {
        for (const tgt of stmt.targets) {
          if (tgt.t === "slice" && tgt.obj) {
            const arr = await this.evalExpr(tgt.obj);
            if (Array.isArray(arr)) {
              const lower = tgt.lower ? Number(await this.evalExpr(tgt.lower)) : 0;
              arr.splice(lower);
            }
          } else if (tgt.t === "sub") {
            const obj = await this.evalExpr(tgt.obj);
            const key = await this.evalExpr(tgt.key);
            if (Array.isArray(obj) && typeof key === "number") {
              obj.splice(key, 1);
            }
          }
        }
        return undefined;
      }

      case "break":
        return new BreakSignal();

      case "continue":
        return new ContinueSignal();

      case "return":
        return new ReturnSignal(stmt.val ? await this.evalExpr(stmt.val) : null);

      case "def": {
        this.functions.set(stmt.name, async (args) => {
          const locals: Record<string, unknown> = {};
          stmt.args.forEach((argName, idx) => {
            locals[argName] = args[idx];
          });
          this.pushScope(locals);
          try {
            const res = await this.execBlock(stmt.body);
            if (res instanceof ReturnSignal) {
              return res.value;
            }
            return null;
          } finally {
            this.popScope();
          }
        });
        return undefined;
      }

      default:
        return undefined;
    }
  }

  private async assignTarget(target: PyExprNode, value: unknown): Promise<void> {
    if (target.t === "name") {
      this.setVar(target.id, value);
      return;
    }
    if (target.t === "attr") {
      const obj = await this.evalExpr(target.obj);
      if (obj && typeof obj === "object") {
        (obj as Record<string, unknown>)[target.attr] = value;
        if (target.obj.t === "name" && target.obj.id === "persistent") {
          this.persistence.savePersistent();
        } else if (
          target.obj.t === "name" &&
          target.obj.id === "config" &&
          target.attr === "allow_skipping"
        ) {
          this.callbacks.setAllowSkipping?.(Boolean(value));
        }
      }
      return;
    }
    if (target.t === "sub") {
      const obj = await this.evalExpr(target.obj);
      const key = await this.evalExpr(target.key);
      if (Array.isArray(obj) && typeof key === "number") {
        obj[key] = value;
      } else if (obj && typeof obj === "object" && key !== null && key !== undefined) {
        (obj as Record<string, unknown>)[String(key)] = value;
      }
    }
  }

  public evalExprSync(node: PyExprNode | null | undefined): unknown {
    if (!node) {
      return null;
    }
    switch (node.t) {
      case "const":
        return node.v;
      case "name": {
        const val = this.getVar(node.id);
        if (val === undefined && this.transformNames.has(node.id)) {
          return node.id;
        }
        return val;
      }
      case "attr": {
        const obj = this.evalExprSync(node.obj);
        if (obj && typeof obj === "object") {
          const rec = obj as Record<string, unknown>;
          const val = rec[node.attr];
          if (typeof val === "function") {
            return val.bind(obj);
          }
          return val;
        }
        return undefined;
      }
      case "sub": {
        const obj = this.evalExprSync(node.obj);
        const key = this.evalExprSync(node.key);
        if ((Array.isArray(obj) || typeof obj === "string") && typeof key === "number") {
          const idx = key < 0 ? obj.length + key : key;
          return obj[idx];
        }
        if (obj && typeof obj === "object") {
          return (obj as Record<string, unknown>)[String(key)];
        }
        return undefined;
      }
      case "slice": {
        const obj = this.evalExprSync(node.obj);
        const lower = node.lower ? Number(this.evalExprSync(node.lower)) : undefined;
        const upper = node.upper ? Number(this.evalExprSync(node.upper)) : undefined;
        if (typeof obj === "string" || Array.isArray(obj)) {
          return obj.slice(lower, upper);
        }
        return obj;
      }
      case "list":
      case "tuple":
        return node.elts.map((e) => this.evalExprSync(e));
      case "dict": {
        const out: Record<string, unknown> = {};
        for (let i = 0; i < node.keys.length; i++) {
          const k = String(this.evalExprSync(node.keys[i]));
          out[k] = this.evalExprSync(node.vals[i]);
        }
        return out;
      }
      case "unary": {
        const v = this.evalExprSync(node.arg);
        if (node.op === "not") {
          return !this.isTruthy(v);
        }
        if (node.op === "-") {
          return -Number(v);
        }
        if (node.op === "+") {
          return +Number(v);
        }
        return v;
      }
      case "bin":
        return this.applyBinOp(
          node.op,
          this.evalExprSync(node.l),
          this.evalExprSync(node.r),
        );
      case "bool": {
        if (node.op === "and") {
          let last: unknown = true;
          for (const v of node.vals) {
            last = this.evalExprSync(v);
            if (!this.isTruthy(last)) {
              return last;
            }
          }
          return last;
        }
        let last: unknown = false;
        for (const v of node.vals) {
          last = this.evalExprSync(v);
          if (this.isTruthy(last)) {
            return last;
          }
        }
        return last;
      }
      case "cmp": {
        let left = this.evalExprSync(node.left);
        for (let i = 0; i < node.ops.length; i++) {
          const right = this.evalExprSync(node.comps[i]);
          if (!this.compareOp(node.ops[i], left, right)) {
            return false;
          }
          left = right;
        }
        return true;
      }
      case "ifexp":
        return this.isTruthy(this.evalExprSync(node.test))
          ? this.evalExprSync(node.body)
          : this.evalExprSync(node.else);
      case "call": {
        const args = node.args.map((a) => this.evalExprSync(a));
        const kwargs: Record<string, unknown> = {};
        for (const kw of node.kwargs) {
          kwargs[kw.k] = this.evalExprSync(kw.v);
        }
        return this.invokeSync(node.fn, args, kwargs);
      }
      default:
        return null;
    }
  }

  public async evalExpr(node: PyExprNode | null | undefined): Promise<unknown> {
    if (!node) {
      return null;
    }
    if (node.t === "call") {
      const args: unknown[] = [];
      for (const a of node.args) {
        args.push(await this.evalExpr(a));
      }
      const kwargs: Record<string, unknown> = {};
      for (const kw of node.kwargs) {
        kwargs[kw.k] = await this.evalExpr(kw.v);
      }
      return this.invokeAsync(node.fn, args, kwargs);
    }
    if (node.t === "bin") {
      const l = await this.evalExpr(node.l);
      const r = await this.evalExpr(node.r);
      return this.applyBinOp(node.op, l, r);
    }
    if (node.t === "list" || node.t === "tuple") {
      const out: unknown[] = [];
      for (const e of node.elts) {
        out.push(await this.evalExpr(e));
      }
      return out;
    }
    if (node.t === "bool") {
      if (node.op === "and") {
        let last: unknown = true;
        for (const v of node.vals) {
          last = await this.evalExpr(v);
          if (!this.isTruthy(last)) {
            return last;
          }
        }
        return last;
      }
      let last: unknown = false;
      for (const v of node.vals) {
        last = await this.evalExpr(v);
        if (this.isTruthy(last)) {
          return last;
        }
      }
      return last;
    }
    return this.evalExprSync(node);
  }

  private invokeSync(
    fnNode: PyExprNode,
    args: unknown[],
    kwargs: Record<string, unknown>,
  ): unknown {
    if (fnNode.t === "name") {
      const fn = this.functions.get(fnNode.id);
      if (fn) {
        return fn(args, kwargs);
      }
    }
    if (fnNode.t === "attr") {
      const target = this.evalExprSync(fnNode.obj);
      return this.callMethod(target, fnNode.attr, args, kwargs);
    }
    return null;
  }

  private async invokeAsync(
    fnNode: PyExprNode,
    args: unknown[],
    kwargs: Record<string, unknown>,
  ): Promise<unknown> {
    if (fnNode.t === "name") {
      const fn = this.functions.get(fnNode.id);
      if (fn) {
        return await fn(args, kwargs);
      }
    }
    if (fnNode.t === "attr") {
      const target = await this.evalExpr(fnNode.obj);
      return await this.callMethod(target, fnNode.attr, args, kwargs);
    }
    return null;
  }

  private callMethod(
    target: unknown,
    method: string,
    args: unknown[],
    kwargs: Record<string, unknown>,
  ): unknown {
    if (typeof target === "string") {
      if (method === "lower") return target.toLowerCase();
      if (method === "upper") return target.toUpperCase();
      if (method === "capitalize") {
        return target.charAt(0).toUpperCase() + target.slice(1);
      }
      if (method === "replace") {
        return target.split(String(args[0] ?? "")).join(String(args[1] ?? ""));
      }
      if (method === "split") {
        return target.split(args[0] ? String(args[0]) : /\s+/);
      }
      if (method === "join") {
        const arr = Array.isArray(args[0]) ? args[0] : [];
        return arr.map(String).join(target);
      }
      if (method === "strip") return target.trim();
    }
    if (Array.isArray(target)) {
      if (method === "append") {
        target.push(args[0]);
        return null;
      }
      if (method === "insert") {
        target.splice(Number(args[0]), 0, args[1]);
        return null;
      }
      if (method === "pop") {
        return args.length ? target.splice(Number(args[0]), 1)[0] : target.pop();
      }
      if (method === "remove") {
        const idx = target.indexOf(args[0]);
        if (idx >= 0) target.splice(idx, 1);
        return null;
      }
    }
    if (target instanceof Set) {
      if (method === "intersection") {
        const other = args[0] instanceof Set ? args[0] : new Set(Array.isArray(args[0]) ? args[0] : []);
        return new Set([...target].filter((x) => other.has(x)));
      }
    }
    if (target && typeof target === "object") {
      const obj = target as Record<string, unknown>;
      const fn = obj[method];
      if (typeof fn === "function") {
        const hasKw = Object.keys(kwargs).length > 0;
        return hasKw ? fn.call(target, ...args, kwargs) : fn.call(target, ...args);
      }
    }
    return null;
  }

  private applyBinOp(op: string, l: unknown, r: unknown): unknown {
    if (op === "+") {
      if (typeof l === "string" || typeof r === "string") {
        return String(l ?? "") + String(r ?? "");
      }
      if (Array.isArray(l) && Array.isArray(r)) {
        return [...l, ...r];
      }
      return Number(l) + Number(r);
    }
    if (op === "-") {
      if (
        l &&
        r &&
        typeof l === "object" &&
        typeof r === "object" &&
        typeof (l as { _ms?: unknown })._ms === "number" &&
        typeof (r as { _ms?: unknown })._ms === "number"
      ) {
        const diffMs = (l as { _ms: number })._ms - (r as { _ms: number })._ms;
        return {
          _ms: diffMs,
          total_seconds: () => diffMs / 1000,
        };
      }
      return Number(l) - Number(r);
    }
    if (op === "*") {
      if (typeof l === "string" && typeof r === "number") {
        return l.repeat(Math.max(0, Math.floor(r)));
      }
      return Number(l) * Number(r);
    }
    if (op === "/") return Number(r) !== 0 ? Number(l) / Number(r) : 0;
    if (op === "//") return Number(r) !== 0 ? Math.floor(Number(l) / Number(r)) : 0;
    if (op === "%") return Number(l) % Number(r);
    if (op === "**") return Math.pow(Number(l), Number(r));
    return null;
  }

  private compareOp(op: string, l: unknown, r: unknown): boolean {
    switch (op) {
      case "==":
        return l === r;
      case "!=":
        return l !== r;
      case "is":
        return l === r;
      case "is not":
        return l !== r;
      case "<":
        return Number(l) < Number(r);
      case "<=":
        return Number(l) <= Number(r);
      case ">":
        return Number(l) > Number(r);
      case ">=":
        return Number(l) >= Number(r);
      case "in":
        if (typeof r === "string") return r.includes(String(l));
        if (Array.isArray(r)) return r.includes(l);
        if (r instanceof Set) return r.has(l);
        return false;
      case "not in":
        if (typeof r === "string") return !r.includes(String(l));
        if (Array.isArray(r)) return !r.includes(l);
        if (r instanceof Set) return !r.has(l);
        return true;
      default:
        return false;
    }
  }

  public isTruthy(v: unknown): boolean {
    if (Array.isArray(v)) return v.length > 0;
    if (v instanceof Set) return v.size > 0;
    return Boolean(v);
  }
}

function toJsonSafeValue(v: unknown, depth = 0): unknown {
  if (depth > 8) {
    return undefined;
  }
  if (
    v === null ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  ) {
    return v;
  }
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (const item of v) {
      const safe = toJsonSafeValue(item, depth + 1);
      if (safe === undefined) {
        return undefined;
      }
      out.push(safe);
    }
    return out;
  }
  if (typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      return undefined;
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "function") {
        return undefined;
      }
      const safe = toJsonSafeValue(val, depth + 1);
      if (safe !== undefined) {
        out[k] = safe;
      }
    }
    return out;
  }
  return undefined;
}
