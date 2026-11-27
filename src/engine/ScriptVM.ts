import type {
  CharacterDef,
  DefaultDef,
  ImageDef,
  PoemDef,
  PyExprNode,
  ScriptFile,
  ScriptIndex,
  ScriptStatement,
} from "../types/game-data";
import type { AudioChannelName, AudioEngine } from "./AudioEngine";
import {
  type BlockPathSegment,
  type Persistence,
  SAVE_FORMAT_VERSION,
  type SaveSlot,
} from "./Persistence";
import { JumpSignal, PyRuntime, RestartSignal } from "./PyRuntime";
import type { SceneManager } from "./SceneManager";
import type { Stage } from "./Stage";
import type { VirtualFS } from "./VirtualFS";
import type { DialogueOverlay } from "../ui/DialogueOverlay";
import type { ModalScreens } from "../ui/ModalScreens";
import type { PoemGameScreen } from "../ui/PoemGameScreen";
import type { PoemViewScreen } from "../ui/PoemViewScreen";

interface Frame {
  labelName: string;
  activeLabel?: string;
  blockPath: BlockPathSegment[];
  statements: ScriptStatement[];
  index: number;
  scopeMap?: Map<string, unknown>;
  isSubroutineBoundary?: boolean;
}

export interface ScriptVMDeps {
  stage: Stage;
  scriptIndex: ScriptIndex;
  loadScript: (stem: string) => Promise<ScriptFile>;
  characters: Record<string, CharacterDef>;
  defaults: DefaultDef[];
  poems: Record<string, PoemDef>;
  scene: SceneManager;
  audio: AudioEngine;
  dialogue: DialogueOverlay;
  modals: ModalScreens;
  poemView: PoemViewScreen;
  persistence: Persistence;
  vfs: VirtualFS;
  onReturnToTitle: () => void;
  onRestartAtLabel: (label?: string) => void;
}

/**
 * Full Ren'Py AST virtual machine executing DDLC's compiled scripts,
 * Python AST blocks, parameterized labels, screens, poems, poem minigame,
 * Monika console, credits, and save/load state.
 */
export class ScriptVM {
  private readonly scriptCache = new Map<string, ScriptFile>();
  public readonly py: PyRuntime;
  private poemGame: PoemGameScreen | null = null;
  private callStack: Frame[] = [];
  private currentLabel = "start";
  private activeInteractiveFrame: Frame | null = null;
  private skipNextHistoryAdd = false;
  private running = false;
  private abortToken = 0;

  public constructor(private readonly deps: ScriptVMDeps) {
    this.py = new PyRuntime(
      deps.defaults,
      deps.poems,
      deps.persistence,
      deps.vfs,
      deps.audio,
      deps.scene,
      {
        pause: (sec) => this.handlePause(sec),
        callScreen: (name, args, kwargs) => this.handleScreenAction("call", name, args, kwargs),
        showScreen: (name, args, kwargs) => {
          void this.handleScreenAction("show", name, args, kwargs);
        },
        hideScreen: (name) => {
          void this.handleScreenAction("hide", name, [], {});
        },
        displayMenu: (items, interact = true) => this.handlePythonMenu(items, interact),
        setDialogueStyle: (styleName) => this.deps.dialogue.setDialogueStyle(styleName),
        setQuickMenu: (visible) => this.deps.dialogue.setQuickMenuVisible(visible),
        setAllowSkipping: (allowed) => this.deps.dialogue.setAllowSkipping(allowed),
        runPoemGame: async () => {
          if (this.poemGame) {
            await this.poemGame.run();
          }
        },
      },
    );

    this.py.setTransformNames(this.deps.scene.getTransformNames());

    this.deps.scene.setEvaluators(
      (ast) => this.py.evalExprSync(ast),
      (expr) => {
        const val = this.py.getVar(expr.trim());
        return typeof val === "number" ? val : parseFloat(expr) || 0;
      },
    );
  }

  public attachPoemGame(poemGame: PoemGameScreen): void {
    this.poemGame = poemGame;
  }

  public resetVariables(): void {
    this.py.reset();
    this.deps.dialogue.setDialogueStyle("normal");
    this.deps.dialogue.setQuickMenuVisible(true);
    this.deps.dialogue.setMonikaTextbox(false);
    this.deps.dialogue.setAllowSkipping(true);
  }

  public stop(): void {
    this.running = false;
    this.abortToken += 1;
    this.activeInteractiveFrame = null;
    this.skipNextHistoryAdd = false;
    this.deps.scene.tear.hide();
    this.deps.scene.invert.hide();
    this.deps.poemView.hide();
    this.deps.dialogue.hide();
  }

  public captureSaveSlot(slot: number): SaveSlot {
    const scState = this.deps.scene.getSnapshotState();
    const uiState = this.deps.dialogue.getUiState();
    const lastEntry =
      this.deps.persistence.history[this.deps.persistence.history.length - 1];
    const activeIdx = this.callStack.length - 1;

    return {
      version: SAVE_FORMAT_VERSION,
      slot,
      label: this.currentLabel,
      callStack: this.callStack.map((f, idx) => {
        // Only rewind the active topmost frame when paused on an interactive
        // statement (`say`, `menu`, `pause`, etc.); parent frames already point
        // to the statement immediately following their `call`/`if`/`menu`.
        const isActiveInteractive =
          idx === activeIdx && this.activeInteractiveFrame === f;
        const savedIndex = isActiveInteractive
          ? Math.max(0, f.index - 1)
          : f.index;
        return {
          label: f.labelName,
          blockPath: [...f.blockPath],
          index: savedIndex,
          localScope: f.scopeMap ? this.py.exportScope(f.scopeMap) : undefined,
          isSubroutineBoundary: f.isSubroutineBoundary,
        };
      }),
      chapter: Number(this.py.getVar("chapter") ?? 0),
      savedAt: new Date().toLocaleString(),
      caption: lastEntry ? lastEntry.what.slice(0, 42) : this.currentLabel,
      thumbnail: this.deps.stage.captureThumbnailDataUrl(),
      variables: this.py.exportVars(),
      sceneState: {
        bg: scState.bg,
        bgAt: scState.bgAt,
        sprites: scState.sprites,
        layerAt: scState.layerAt,
        music: this.deps.audio.getPlaying("music"),
        dialogueStyle: uiState.dialogueStyle,
        quickMenuVisible: uiState.quickMenuVisible,
        monikaTextbox: uiState.monikaTextbox,
      },
      history: [...this.deps.persistence.history],
    };
  }

  public async restoreFromSaveSlot(slot: SaveSlot): Promise<void> {
    if (slot.version !== SAVE_FORMAT_VERSION) {
      await this.deps.modals.showDialog(
        "This save file is from an incompatible version and cannot be loaded.",
      );
      return;
    }

    this.stop();
    this.resetVariables();
    this.py.clearScopes();
    this.py.importVars(slot.variables);

    if (slot.history) {
      this.deps.persistence.setHistory(slot.history);
    }

    await this.deps.scene.restoreSnapshot(slot.sceneState);
    this.deps.dialogue.setDialogueStyle(slot.sceneState.dialogueStyle || "normal");
    this.deps.dialogue.setQuickMenuVisible(slot.sceneState.quickMenuVisible);
    this.deps.dialogue.setMonikaTextbox(slot.sceneState.monikaTextbox);

    if (slot.sceneState.music) {
      await this.deps.audio.play("music", slot.sceneState.music).catch(() => {});
    } else {
      this.deps.audio.stop("music", 0);
    }

    const token = ++this.abortToken;
    this.running = true;
    this.currentLabel = slot.label;
    this.callStack = [];

    for (const savedFrame of slot.callStack) {
      let rootBlock: ScriptStatement[] | null = null;
      if (savedFrame.label.startsWith("__file__:")) {
        const stem = savedFrame.label.slice("__file__:".length);
        const script = await this.loadScript(stem);
        rootBlock = script.statements;
      } else {
        const found = await this.findLabelNode(savedFrame.label);
        rootBlock = found ? found.block : null;
      }
      if (!rootBlock) {
        continue;
      }
      const block = resolveBlockPath(rootBlock, savedFrame.blockPath ?? []);
      if (!block) {
        continue;
      }
      const scopeMap = savedFrame.localScope
        ? this.py.pushScope(savedFrame.localScope)
        : undefined;
      this.callStack.push({
        labelName: savedFrame.label,
        blockPath: [...(savedFrame.blockPath ?? [])],
        statements: block,
        index: savedFrame.index,
        scopeMap,
        isSubroutineBoundary: savedFrame.isSubroutineBoundary,
      });
    }

    if (this.callStack.length === 0) {
      await this.runFromLabel(slot.label);
      return;
    }

    const topFrame = this.callStack[this.callStack.length - 1];
    this.skipNextHistoryAdd =
      Boolean(slot.history && slot.history.length > 0) &&
      topFrame?.statements[topFrame.index]?.type === "say";

    if (slot.label !== "after_load") {
      await this.pushLabelEntry("after_load");
    }

    await this.runLoop(token);
  }

  public async runFromLabel(labelName: string): Promise<void> {
    const token = ++this.abortToken;
    this.running = true;
    this.currentLabel = labelName;
    this.skipNextHistoryAdd = false;
    this.py.clearScopes();

    // Special case: `poem` label invokes our interactive PoemGameScreen
    if (labelName === "poem") {
      await this.poemGame?.run();
      this.running = false;
      this.deps.onReturnToTitle();
      return;
    }

    this.callStack = [];
    const entered = await this.pushLabelEntry(labelName);
    if (!entered) {
      console.error(`[ScriptVM] Label not found: ${labelName}`);
      this.deps.onReturnToTitle();
      return;
    }

    await this.runLoop(token);
  }

  private async runLoop(token: number): Promise<void> {
    while (this.running && token === this.abortToken && this.callStack.length > 0) {
      const frame = this.callStack[this.callStack.length - 1];
      if (frame.index >= frame.statements.length) {
        if (frame.scopeMap) {
          this.py.popScope();
        }
        this.callStack.pop();
        this.syncCurrentLabelFromStack();
        continue;
      }

      const stmt = frame.statements[frame.index];
      frame.index += 1;

      try {
        const control = await this.executeStatement(stmt, frame, token);
        if (control === "stop") {
          break;
        }
      } catch (err) {
        if (err instanceof JumpSignal) {
          await this.performJump(err.target);
          continue;
        }
        if (err instanceof RestartSignal) {
          this.stop();
          this.deps.onRestartAtLabel(err.label);
          return;
        }
        throw err;
      } finally {
        this.activeInteractiveFrame = null;
      }
    }

    if (token === this.abortToken && this.running) {
      this.running = false;
      this.deps.dialogue.hide();
      this.deps.onReturnToTitle();
    }
  }

  private syncCurrentLabelFromStack(): void {
    for (let i = this.callStack.length - 1; i >= 0; i--) {
      const candidate =
        this.callStack[i].activeLabel ?? this.callStack[i].labelName;
      if (candidate && !candidate.startsWith("__file__:")) {
        this.currentLabel = candidate;
        return;
      }
    }
  }

  /**
   * Unwinds structural sub-block frames (`if`/`menu`/`while`/nested `label`)
   * plus the enclosing subroutine/root frame (`blockPath.length === 0`), leaving
   * outer `call` frames intact for subsequent `return` statements.
   */
  private popCurrentSubroutine(): void {
    while (this.callStack.length > 0) {
      const top = this.callStack.pop()!;
      if (top.scopeMap) {
        this.py.popScope();
      }
      if (
        top.isSubroutineBoundary === true ||
        (top.isSubroutineBoundary === undefined && top.blockPath.length === 0)
      ) {
        break;
      }
    }
    this.syncCurrentLabelFromStack();
  }

  private async pushLabelEntry(
    target: string,
    scopeMap?: Map<string, unknown>,
  ): Promise<boolean> {
    const chain = await this.findLabelChain(target);
    if (!chain) {
      return false;
    }
    this.currentLabel = target;
    this.deps.persistence.markLabelSeen(target);

    for (let i = 0; i < chain.parents.length; i++) {
      const p = chain.parents[i];
      this.callStack.push({
        labelName: p.labelName,
        blockPath: p.blockPath,
        statements: p.statements,
        index: p.nextIndex,
        isSubroutineBoundary: i === 0,
      });
    }

    this.callStack.push({
      labelName: target,
      blockPath: [],
      statements: chain.labelNode.block,
      index: 0,
      scopeMap,
      isSubroutineBoundary: chain.parents.length === 0,
    });
    return true;
  }

  private async performJump(target: string): Promise<void> {
    this.popCurrentSubroutine();

    const entered = await this.pushLabelEntry(target);
    if (!entered) {
      console.warn(`[ScriptVM] Jump target not found: ${target}`);
    }
  }

  private async executeStatement(
    stmt: ScriptStatement,
    frame: Frame,
    token: number,
  ): Promise<"continue" | "stop"> {
    if (!this.running || token !== this.abortToken) {
      return "stop";
    }

    switch (stmt.type) {
      case "say": {
        const s = stmt as Extract<ScriptStatement, { type: "say" }>;
        if (
          this.deps.persistence.data.playthrough === 3 &&
          !this.deps.persistence.data.monika_kill &&
          this.currentLabel.startsWith("ch30_") &&
          this.currentLabel !== "ch30_end" &&
          this.currentLabel !== "ch30_end_2" &&
          this.currentLabel !== "ch30_endb"
        ) {
          if (!this.deps.vfs.exists("characters/monika.chr")) {
            this.deps.persistence.data.tried_skip = true;
            this.deps.persistence.savePersistent();
            this.deps.dialogue.hide();
            await this.handlePause(2.0);
            await this.performJump("ch30_end");
            return "continue";
          }
          if (
            this.deps.dialogue.isSkipping() &&
            /^ch30_(?:loop|\d+)$/.test(this.currentLabel)
          ) {
            this.deps.dialogue.setSkipping(false);
            this.deps.dialogue.setAllowSkipping(false);
            this.deps.persistence.data.tried_skip = true;
            this.deps.persistence.savePersistent();
            await this.performJump("ch30_noskip");
            return "continue";
          }
        }
        if (s.attributes && s.attributes.length > 0 && s.who) {
          const charDef = this.deps.characters[s.who];
          const imageTag = charDef?.kwargs?.image;
          if (typeof imageTag === "string" && this.deps.scene.hasSprite(imageTag)) {
            await this.deps.scene.show(`${imageTag} ${s.attributes.join(" ")}`, [], {
              tag: imageTag,
            });
          }
        }
        const speaker = this.resolveSpeaker(s.who);
        const text = this.interpolateText(s.what);
        const lineKey = `${frame.labelName}:${s.line}:${frame.index - 1}`;
        const wasSeen = this.deps.persistence.isLineSeen(lineKey);
        const interact = s.interact !== false;

        if (
          interact &&
          this.deps.dialogue.isSkipping() &&
          !wasSeen &&
          !this.deps.persistence.data.preferences.skipUnseen
        ) {
          this.deps.dialogue.setSkipping(false);
        }

        if (this.skipNextHistoryAdd) {
          this.skipNextHistoryAdd = false;
        } else {
          this.deps.persistence.addHistory(speaker, text);
        }
        this.activeInteractiveFrame = frame;
        await this.deps.dialogue.showLine(speaker, text, interact, wasSeen);
        this.deps.persistence.markLineSeen(lineKey);

        if (s.with && !this.deps.dialogue.isSkipping()) {
          await this.deps.scene.runTransition(s.with);
        } else {
          this.deps.scene.markTransitionCheckpoint();
        }
        return "continue";
      }

      case "scene": {
        const s = stmt as Extract<ScriptStatement, { type: "scene" }>;
        this.deps.dialogue.hideChoices();
        this.deps.dialogue.hide();
        const resolved = this.resolveImspecDisplay(s.imspec);
        if (resolved.name) {
          await this.deps.scene.setScene(resolved.name, {
            layer: s.layer,
            at: s.imspec.at ?? [],
            paramText: resolved.paramText,
            atl: s.atl,
          });
        }
        return "continue";
      }

      case "show": {
        const s = stmt as Extract<ScriptStatement, { type: "show" }>;
        const resolved = this.resolveImspecDisplay(s.imspec);
        if (resolved.name || resolved.def) {
          await this.deps.scene.show(resolved.name, s.imspec.at ?? [], {
            tag: s.imspec.tag,
            layer: s.imspec.layer,
            zorder: s.imspec.zorder,
            paramText: resolved.paramText,
            def: resolved.def,
            atl: s.atl,
          });
        }
        return "continue";
      }

      case "hide": {
        const s = stmt as Extract<ScriptStatement, { type: "hide" }>;
        const name = s.imspec.tag || s.imspec.name.join(" ");
        if (name) {
          await this.deps.scene.hide(name);
        }
        return "continue";
      }

      case "showLayer": {
        const s = stmt as Extract<ScriptStatement, { type: "showLayer" }>;
        this.deps.scene.showLayer(s.layer, s.at, s.atl);
        return "continue";
      }

      case "with": {
        const s = stmt as Extract<ScriptStatement, { type: "with" }>;
        if (this.deps.dialogue.isSkipping()) {
          this.deps.scene.markTransitionCheckpoint();
          return "continue";
        }
        let resolvedMs: number | undefined;
        if (s.exprAst && s.expr?.startsWith("Dissolve")) {
          const val = await this.py.evalExpr(s.exprAst);
          if (typeof val === "number") {
            resolvedMs = val * 1000;
          }
        }
        await this.deps.scene.runTransition(s.expr, resolvedMs);
        return "continue";
      }

      case "play": {
        const s = stmt as Extract<ScriptStatement, { type: "play" }>;
        await this.handlePlay(s.channel, s.args, token);
        return "continue";
      }

      case "queue": {
        const s = stmt as Extract<ScriptStatement, { type: "queue" }>;
        const track = this.extractFirstTrackToken(s.args);
        if (track) {
          this.deps.audio.queueTrack(this.mapChannel(s.channel), track);
        }
        return "continue";
      }

      case "stop": {
        const s = stmt as Extract<ScriptStatement, { type: "stop" }>;
        const fadeMatch = /fadeout\s+([0-9]+(?:\.[0-9]+)?)/.exec(s.args);
        const fadeout = fadeMatch ? parseFloat(fadeMatch[1]) : 0;
        this.deps.audio.stop(this.mapChannel(s.channel), fadeout);
        return "continue";
      }

      case "pause": {
        const s = stmt as Extract<ScriptStatement, { type: "pause" }>;
        let sec: number | null = null;
        if (s.durationAst) {
          const v = await this.py.evalExpr(s.durationAst);
          sec = typeof v === "number" ? v : null;
        } else if (s.duration) {
          const n = parseFloat(s.duration);
          sec = Number.isNaN(n) ? null : n;
        }
        this.activeInteractiveFrame = frame;
        await this.handlePause(sec);
        return "continue";
      }

      case "window": {
        const s = stmt as Extract<ScriptStatement, { type: "window" }>;
        if (s.mode === "hide" || s.mode.startsWith("hide(")) {
          this.deps.dialogue.hide();
        }
        return "continue";
      }

      case "screen": {
        const s = stmt as Extract<ScriptStatement, { type: "screen" }>;
        let args: unknown[] = [];
        const kwargs: Record<string, unknown> = {};
        if (s.callAst && s.callAst.t === "call") {
          for (const a of s.callAst.args) {
            args.push(await this.py.evalExpr(a));
          }
          for (const kw of s.callAst.kwargs) {
            kwargs[kw.k] = await this.py.evalExpr(kw.v);
          }
        }
        const res = await this.handleScreenAction(s.action, s.name, args, kwargs);
        this.py.setVar("_return", res);
        return "continue";
      }

      case "jump": {
        const s = stmt as Extract<ScriptStatement, { type: "jump" }>;
        const target = s.expression && s.targetAst
          ? String(await this.py.evalExpr(s.targetAst))
          : s.target;
        await this.performJump(target);
        if (this.callStack.length === 0) {
          return "stop";
        }
        return "continue";
      }

      case "call": {
        const s = stmt as Extract<ScriptStatement, { type: "call" }>;
        const target = s.expression && s.labelAst
          ? String(await this.py.evalExpr(s.labelAst))
          : s.label;

        if (target === "poem") {
          this.activeInteractiveFrame = frame;
          await this.poemGame?.run();
          return "continue";
        }

        const found = await this.findLabelNode(target);
        if (!found) {
          console.warn(`[ScriptVM] Call target not found: ${target}`);
          return "continue";
        }

        const paramDefs = found.paramDefs ?? found.params.map((p) => ({ name: p, defaultAst: null }));
        let scopeMap: Map<string, unknown> | undefined;
        if (paramDefs.length > 0) {
          const locals: Record<string, unknown> = {};
          for (const p of paramDefs) {
            locals[p.name] = p.defaultAst ? await this.py.evalExpr(p.defaultAst) : null;
          }
          let posIdx = 0;
          for (const arg of s.args ?? []) {
            const val = arg.ast ? await this.py.evalExpr(arg.ast) : null;
            if (arg.name) {
              locals[arg.name] = val;
            } else if (posIdx < paramDefs.length) {
              locals[paramDefs[posIdx].name] = val;
              posIdx += 1;
            }
          }
          scopeMap = this.py.pushScope(locals);
        }
        await this.pushLabelEntry(target, scopeMap);
        return "continue";
      }

      case "return": {
        this.popCurrentSubroutine();
        return "continue";
      }

      case "label": {
        const s = stmt as Extract<ScriptStatement, { type: "label" }>;
        this.currentLabel = s.name;
        this.deps.persistence.markLabelSeen(s.name);
        this.callStack.push({
          labelName: frame.labelName,
          activeLabel: s.name,
          blockPath: [
            ...frame.blockPath,
            { kind: "label", stmtIndex: frame.index - 1 },
          ],
          statements: s.block,
          index: 0,
        });
        return "continue";
      }

      case "menu": {
        const s = stmt as Extract<ScriptStatement, { type: "menu" }>;
        const stmtIndex = frame.index - 1;
        const promptItem = s.items.find((item) => item.block === null && item.caption);
        if (promptItem && promptItem.caption) {
          const text = this.interpolateText(promptItem.caption);
          this.deps.dialogue.showStaticPrompt(null, text);
        }

        const visibleChoices: Array<{ itemIndex: number; item: (typeof s.items)[number] }> = [];
        for (let idx = 0; idx < s.items.length; idx++) {
          const item = s.items[idx];
          if (item.block === null || !item.caption) {
            continue;
          }
          const ok = item.condAst
            ? this.py.isTruthy(await this.py.evalExpr(item.condAst))
            : true;
          if (ok) {
            visibleChoices.push({ itemIndex: idx, item });
          }
        }

        if (visibleChoices.length > 0) {
          const labels = visibleChoices.map((entry) =>
            this.interpolateText(entry.item.caption ?? ""),
          );
          const isRigged =
            this.deps.persistence.data.playthrough === 2 &&
            labels.some((l) => l.toLowerCase().includes("monika"));
          this.activeInteractiveFrame = frame;
          const chosenIndex = await this.deps.dialogue.showChoices(labels, isRigged);
          const chosen = visibleChoices[chosenIndex];
          if (chosen && chosen.item.block) {
            this.callStack.push({
              labelName: frame.labelName,
              blockPath: [
                ...frame.blockPath,
                { kind: "menu", stmtIndex, itemIndex: chosen.itemIndex },
              ],
              statements: chosen.item.block,
              index: 0,
            });
          }
        }
        return "continue";
      }

      case "if": {
        const s = stmt as Extract<ScriptStatement, { type: "if" }>;
        const stmtIndex = frame.index - 1;
        for (let bi = 0; bi < s.branches.length; bi++) {
          const branch = s.branches[bi];
          const ok = branch.condAst
            ? this.py.isTruthy(await this.py.evalExpr(branch.condAst))
            : branch.condition === "True";
          if (ok) {
            this.callStack.push({
              labelName: frame.labelName,
              blockPath: [
                ...frame.blockPath,
                { kind: "if", stmtIndex, branchIndex: bi },
              ],
              statements: branch.block,
              index: 0,
            });
            break;
          }
        }
        return "continue";
      }

      case "while": {
        const s = stmt as Extract<ScriptStatement, { type: "while" }>;
        const stmtIndex = frame.index - 1;
        const ok = s.condAst
          ? this.py.isTruthy(await this.py.evalExpr(s.condAst))
          : false;
        if (ok) {
          frame.index = stmtIndex;
          this.callStack.push({
            labelName: frame.labelName,
            blockPath: [...frame.blockPath, { kind: "while", stmtIndex }],
            statements: s.block,
            index: 0,
          });
        }
        return "continue";
      }

      case "python": {
        const s = stmt as Extract<ScriptStatement, { type: "python" }>;
        if (s.pyAst && s.pyAst.length > 0) {
          this.activeInteractiveFrame = frame;
          await this.py.execBlock(s.pyAst);
        }
        return "continue";
      }

      default: {
        return "continue";
      }
    }
  }

  private resolveImspecDisplay(imspec: {
    name: string[];
    expression?: string;
    exprAst?: PyExprNode | null;
  }): { name: string; paramText?: string; def?: ImageDef } {
    if (imspec.exprAst) {
      if (
        imspec.exprAst.t === "call" &&
        imspec.exprAst.fn.t === "name" &&
        imspec.exprAst.fn.id === "Text"
      ) {
        const rawText = imspec.exprAst.args[0]
          ? String(this.py.evalExprSync(imspec.exprAst.args[0]) ?? "")
          : "";
        const props: Record<string, unknown> = {};
        for (const kw of imspec.exprAst.kwargs) {
          props[kw.k] = this.py.evalExprSync(kw.v);
        }
        const styleName = typeof props.style === "string" ? props.style : "";
        return {
          name: styleName || "inline_text",
          def: {
            kind: "text",
            parameterized: false,
            text: this.interpolateText(rawText),
            props,
          },
        };
      }
      const evaluated = this.py.evalExprSync(imspec.exprAst);
      if (typeof evaluated === "string") {
        const unquoted = evaluated.replace(/^["']|["']$/g, "");
        return { name: unquoted };
      }
    }

    const parts = imspec.name;
    // Handle ParameterizedText shows like `console_text "[text]"` or `splash_warning "[splash_message]"`
    if (parts.length >= 2) {
      const last = parts[parts.length - 1];
      if (
        (last.startsWith('"') && last.endsWith('"')) ||
        (last.startsWith("'") && last.endsWith("'"))
      ) {
        const baseName = parts.slice(0, -1).join(" ");
        const paramText = this.interpolateText(last.slice(1, -1));
        return { name: baseName, paramText };
      }
    }

    const joined = parts.join(" ");
    // Handle `Solid("...")` or `Text("...")` inline expressions
    if (joined.startsWith("Solid(")) {
      const m = /Solid\(["']([^"']+)["']\)/.exec(joined);
      if (m) {
        const hex = m[1].startsWith("#") ? m[1] : `#${m[1]}`;
        return { name: joined, def: { kind: "color", hex } };
      }
    }

    return { name: joined };
  }

  private async handleScreenAction(
    action: "show" | "hide" | "call",
    name: string,
    args: unknown[],
    kwargs: Record<string, unknown>,
  ): Promise<unknown> {
    if (name === "poem") {
      if (action === "hide") {
        this.deps.poemView.hide();
        return null;
      }
      const poem = args[0] as PoemDef | undefined;
      const paper = typeof kwargs.paper === "string" ? kwargs.paper : "paper";
      if (poem) {
        this.deps.poemView.show(
          poem,
          paper,
          !this.deps.persistence.data.first_poem,
        );
      }
      return null;
    }

    if (name === "tear") {
      if (action === "hide") {
        this.deps.scene.tear.hide();
      } else {
        this.deps.scene.tear.show(
          Number(args[0] ?? 10),
          Number(kwargs.offtimeMult ?? args[1] ?? 1),
          Number(kwargs.ontimeMult ?? args[2] ?? 1),
          Number(args[3] ?? -10),
          Number(args[4] ?? 10),
        );
      }
      return null;
    }

    if (name === "invert") {
      if (action === "hide") {
        this.deps.scene.invert.hide();
      } else {
        this.deps.scene.invert.show(
          Number(args[0] ?? 0.15),
          Number(args[1] ?? 0),
          this.deps.audio,
        );
      }
      return null;
    }

    if (name === "fake_skip_indicator") {
      this.deps.modals.setSkipIndicator(action !== "hide");
      return null;
    }

    if (name === "quick_menu") {
      this.deps.dialogue.setQuickMenuVisible(action !== "hide");
      return null;
    }

    if (name === "dialog" && action === "call") {
      const msg = this.interpolateText(String(kwargs.message ?? args[0] ?? ""));
      await this.deps.modals.showDialog(msg);
      return true;
    }

    if (name === "confirm" && action === "call") {
      const msg = this.interpolateText(String(kwargs.message ?? args[0] ?? ""));
      const glitched = this.deps.persistence.data.playthrough === 2;
      return this.deps.modals.showConfirm(msg, "Yes", "No", glitched);
    }

    return null;
  }

  private async handlePythonMenu(
    items: Array<[string, unknown]>,
    interact = true,
  ): Promise<unknown> {
    const safeItems = Array.isArray(items) ? items : [];
    const labels = safeItems.map(([cap]) => this.interpolateText(String(cap)));
    if (!interact) {
      this.deps.dialogue.showPassiveChoices(labels);
      return null;
    }
    const idx = await this.deps.dialogue.showChoices(labels, false);
    return safeItems[idx]?.[1] ?? null;
  }

  private async handlePause(seconds?: number | null): Promise<void> {
    if (seconds === undefined || seconds === null) {
      if (this.deps.poemView.isOpen()) {
        await this.deps.poemView.waitForDismiss();
      } else {
        await this.deps.dialogue.waitForClick();
      }
      return;
    }
    if (seconds <= 0) {
      return;
    }
    const ms = this.deps.dialogue.isSkipping() ? Math.min(seconds * 1000, 60) : seconds * 1000;
    await new Promise<void>((resolve) => window.setTimeout(resolve, ms));
  }

  private mapChannel(channel: string): AudioChannelName {
    if (channel === "music_poem") return "music_poem";
    if (channel === "sound" || channel === "sound2") return "sound";
    if (channel === "sfx") return "sfx";
    return "music";
  }

  private evaluateAudioPiece(piece: string): string {
    const p = piece.trim();
    if (!p) {
      return "";
    }
    const q = /^["']([\s\S]*)["']$/.exec(p);
    if (q) {
      return q[1];
    }
    const strCall = /^str\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)$/.exec(p);
    const varName = strCall ? strCall[1] : (/^[A-Za-z_][A-Za-z0-9_]*$/.test(p) ? p : null);
    if (varName) {
      const val = this.py.getVar(varName);
      if (val !== undefined && val !== null) {
        return String(val);
      }
      return varName === "currentpos" ? "0" : "";
    }
    return p;
  }

  private evaluateAudioExpr(expr: string): string {
    const trimmed = expr.trim();
    const parts: string[] = [];
    let current = "";
    let quote: string | null = null;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (quote) {
        current += ch;
        if (ch === quote && trimmed[i - 1] !== "\\") {
          quote = null;
        }
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        current += ch;
      } else if (ch === "+") {
        parts.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    parts.push(current);

    if (parts.length > 1) {
      return parts.map((p) => this.evaluateAudioPiece(p)).join("");
    }
    const q = /^["']([\s\S]*)["']$/.exec(trimmed);
    return q ? q[1] : trimmed.replace(/^["']|["']$/g, "");
  }

  private parsePlaySpec(args: string): { tracks: string[]; silenceSec: number } {
    const trimmed = args.trim();
    // Split off trailing Ren'Py modifiers (fadein/fadeout/loop/noloop) outside quotes and brackets.
    let head = trimmed;
    let quote: string | null = null;
    let bracketDepth = 0;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (quote) {
        if (ch === quote && trimmed[i - 1] !== "\\") {
          quote = null;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === "[") {
        bracketDepth += 1;
      } else if (ch === "]" && bracketDepth > 0) {
        bracketDepth -= 1;
      } else if (bracketDepth === 0 && /\s/.test(ch)) {
        const rest = trimmed.slice(i).trimStart();
        if (/^(?:fadein|fadeout|noloop|loop)\b/.test(rest)) {
          head = trimmed.slice(0, i).trim();
          break;
        }
      }
    }

    const tracks: string[] = [];
    let silenceSec = 0;
    if (head.startsWith("[") && head.endsWith("]")) {
      const inner = head.slice(1, -1);
      const itemRegex = /"([^"]*)"|'([^']*)'/g;
      let match: RegExpExecArray | null;
      while ((match = itemRegex.exec(inner)) !== null) {
        const val = (match[1] ?? match[2] ?? "").trim();
        const silenceMatch = /^<silence\s+([0-9]+(?:\.[0-9]+)?)\s*>$/i.exec(val);
        if (silenceMatch) {
          silenceSec += parseFloat(silenceMatch[1]);
        } else if (val) {
          tracks.push(val);
        }
      }
      return { tracks, silenceSec };
    }

    const resolved = this.evaluateAudioExpr(head).trim();
    if (resolved) {
      tracks.push(resolved);
    }
    return { tracks, silenceSec };
  }

  private extractFirstTrackToken(args: string): string {
    return this.parsePlaySpec(args).tracks[0] ?? "";
  }

  private async playTracks(
    channel: AudioChannelName,
    tracks: string[],
    fadein: number,
    noloop: boolean,
  ): Promise<void> {
    try {
      await this.deps.audio.play(channel, tracks[0], {
        fadein,
        loop: noloop ? false : undefined,
      });
      for (const nextTrack of tracks.slice(1)) {
        this.deps.audio.queueTrack(channel, nextTrack);
      }
    } catch (err) {
      console.warn(`[ScriptVM] Audio play skipped for "${tracks[0]}":`, err);
    }
  }

  private async handlePlay(channel: string, args: string, token?: number): Promise<void> {
    const trimmed = args.trim();
    const fadeMatch = /fadein\s+([0-9]+(?:\.[0-9]+)?)/.exec(trimmed);
    const fadein = fadeMatch ? parseFloat(fadeMatch[1]) : 0;
    const noloop = /\bnoloop\b/.test(trimmed);
    const { tracks, silenceSec } = this.parsePlaySpec(trimmed);
    if (tracks.length === 0) {
      return;
    }
    const mappedChannel = this.mapChannel(channel);
    if (silenceSec > 0) {
      this.deps.audio.stop(mappedChannel, 0);
      const delayMs = this.deps.dialogue.isSkipping()
        ? Math.min(silenceSec * 1000, 60)
        : silenceSec * 1000;
      window.setTimeout(() => {
        if (token !== undefined && (!this.running || token !== this.abortToken)) {
          return;
        }
        void this.playTracks(mappedChannel, tracks, fadein, noloop);
      }, delayMs);
      return;
    }
    await this.playTracks(mappedChannel, tracks, fadein, noloop);
  }

  private resolveSpeaker(who: string | null): string | null {
    if (!who) {
      return null;
    }
    const def = this.deps.characters[who];
    if (!def) {
      return who;
    }
    if (def.dynamic && def.name) {
      const val = this.py.getVar(def.name);
      if (typeof val === "string") {
        return val;
      }
      return def.name;
    }
    return def.name;
  }

  private interpolateText(raw: string): string {
    return raw.replace(
      /\[([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*|\[[a-zA-Z0-9_]+\])*)\]/g,
      (_match, expr: string) => {
        if (expr === "player") {
          return String(
            this.py.getVar("player") || this.deps.persistence.data.playername || "MC",
          );
        }
        const val = this.resolveInterpolatedExpr(expr);
        if (val === undefined || val === null) {
          return `[${expr}]`;
        }
        return String(val);
      },
    );
  }

  private resolveInterpolatedExpr(expr: string): unknown {
    const tokenRe = /^([a-zA-Z_][a-zA-Z0-9_]*)|\.([a-zA-Z_][a-zA-Z0-9_]*)|\[([a-zA-Z0-9_]+)\]/g;
    let cur: unknown;
    let first = true;
    let match: RegExpExecArray | null;
    while ((match = tokenRe.exec(expr)) !== null) {
      if (first) {
        first = false;
        cur = this.py.getVar(match[1]);
      } else if (match[2] !== undefined) {
        if (cur && typeof cur === "object") {
          cur = (cur as Record<string, unknown>)[match[2]];
        } else {
          return undefined;
        }
      } else if (match[3] !== undefined) {
        const keyRaw = match[3];
        const key = /^\d+$/.test(keyRaw) ? Number(keyRaw) : this.py.getVar(keyRaw);
        if ((Array.isArray(cur) || typeof cur === "string") && typeof key === "number") {
          cur = cur[key < 0 ? cur.length + key : key];
        } else if (cur && typeof cur === "object" && key !== undefined && key !== null) {
          cur = (cur as Record<string, unknown>)[String(key)];
        } else {
          return undefined;
        }
      }
    }
    return cur;
  }

  private async loadScript(stem: string): Promise<ScriptFile> {
    const cached = this.scriptCache.get(stem);
    if (cached) {
      return cached;
    }
    const loaded = await this.deps.loadScript(stem);
    this.scriptCache.set(stem, loaded);
    return loaded;
  }

  private async findLabelNode(
    labelName: string,
  ): Promise<Extract<ScriptStatement, { type: "label" }> | null> {
    const stem = this.deps.scriptIndex.labels[labelName];
    if (!stem) {
      return null;
    }
    const script = await this.loadScript(stem);
    return findLabelObjInList(script.statements, labelName);
  }

  private async findLabelChain(labelName: string): Promise<{
    labelNode: Extract<ScriptStatement, { type: "label" }>;
    parents: Array<{
      labelName: string;
      blockPath: BlockPathSegment[];
      statements: ScriptStatement[];
      nextIndex: number;
    }>;
  } | null> {
    const stem = this.deps.scriptIndex.labels[labelName];
    if (!stem) {
      return null;
    }
    const script = await this.loadScript(stem);
    return findLabelChainInList(
      script.statements,
      labelName,
      `__file__:${stem}`,
      [],
    );
  }
}

export function resolveBlockPath(
  rootBlock: ScriptStatement[],
  blockPath: BlockPathSegment[],
): ScriptStatement[] | null {
  let current: ScriptStatement[] = rootBlock;
  for (const seg of blockPath) {
    const stmt = current[seg.stmtIndex];
    if (!stmt) {
      return null;
    }
    if (seg.kind === "if" && stmt.type === "if") {
      const ifStmt = stmt as Extract<ScriptStatement, { type: "if" }>;
      const branch = ifStmt.branches[seg.branchIndex];
      if (!branch) {
        return null;
      }
      current = branch.block;
    } else if (seg.kind === "menu" && stmt.type === "menu") {
      const menuStmt = stmt as Extract<ScriptStatement, { type: "menu" }>;
      const item = menuStmt.items[seg.itemIndex];
      if (!item || !item.block) {
        return null;
      }
      current = item.block;
    } else if (seg.kind === "while" && stmt.type === "while") {
      const whileStmt = stmt as Extract<ScriptStatement, { type: "while" }>;
      current = whileStmt.block;
    } else if (seg.kind === "label" && stmt.type === "label") {
      const lblStmt = stmt as Extract<ScriptStatement, { type: "label" }>;
      current = lblStmt.block;
    } else {
      return null;
    }
  }
  return current;
}

function findLabelObjInList(
  statements: ScriptStatement[],
  labelName: string,
): Extract<ScriptStatement, { type: "label" }> | null {
  for (const stmt of statements) {
    if (stmt.type === "label") {
      const lbl = stmt as Extract<ScriptStatement, { type: "label" }>;
      if (lbl.name === labelName) {
        return lbl;
      }
      const nested = findLabelObjInList(lbl.block, labelName);
      if (nested) {
        return nested;
      }
    } else if (stmt.type === "if") {
      const ifStmt = stmt as Extract<ScriptStatement, { type: "if" }>;
      for (const branch of ifStmt.branches) {
        const nested = findLabelObjInList(branch.block, labelName);
        if (nested) {
          return nested;
        }
      }
    } else if (stmt.type === "menu") {
      const menuStmt = stmt as Extract<ScriptStatement, { type: "menu" }>;
      for (const item of menuStmt.items) {
        if (item.block) {
          const nested = findLabelObjInList(item.block, labelName);
          if (nested) {
            return nested;
          }
        }
      }
    }
  }
  return null;
}

function findLabelChainInList(
  statements: ScriptStatement[],
  labelName: string,
  ownerLabel: string,
  ownerPath: BlockPathSegment[],
): {
  labelNode: Extract<ScriptStatement, { type: "label" }>;
  parents: Array<{
    labelName: string;
    blockPath: BlockPathSegment[];
    statements: ScriptStatement[];
    nextIndex: number;
  }>;
} | null {
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    if (stmt.type === "label") {
      const lbl = stmt as Extract<ScriptStatement, { type: "label" }>;
      if (lbl.name === labelName) {
        return {
          labelNode: lbl,
          parents: [
            {
              labelName: ownerLabel,
              blockPath: ownerPath,
              statements,
              nextIndex: i + 1,
            },
          ],
        };
      }
      const nested = findLabelChainInList(
        lbl.block,
        labelName,
        ownerLabel,
        [...ownerPath, { kind: "label", stmtIndex: i }],
      );
      if (nested) {
        return {
          labelNode: nested.labelNode,
          parents: [
            {
              labelName: ownerLabel,
              blockPath: ownerPath,
              statements,
              nextIndex: i + 1,
            },
            ...nested.parents,
          ],
        };
      }
    } else if (stmt.type === "if") {
      const ifStmt = stmt as Extract<ScriptStatement, { type: "if" }>;
      for (let bi = 0; bi < ifStmt.branches.length; bi++) {
        const nested = findLabelChainInList(
          ifStmt.branches[bi].block,
          labelName,
          ownerLabel,
          [...ownerPath, { kind: "if", stmtIndex: i, branchIndex: bi }],
        );
        if (nested) {
          return {
            labelNode: nested.labelNode,
            parents: [
              {
                labelName: ownerLabel,
                blockPath: ownerPath,
                statements,
                nextIndex: i + 1,
              },
              ...nested.parents,
            ],
          };
        }
      }
    } else if (stmt.type === "menu") {
      const menuStmt = stmt as Extract<ScriptStatement, { type: "menu" }>;
      for (let ii = 0; ii < menuStmt.items.length; ii++) {
        const item = menuStmt.items[ii];
        if (item.block) {
          const nested = findLabelChainInList(
            item.block,
            labelName,
            ownerLabel,
            [...ownerPath, { kind: "menu", stmtIndex: i, itemIndex: ii }],
          );
          if (nested) {
            return {
              labelNode: nested.labelNode,
              parents: [
                {
                  labelName: ownerLabel,
                  blockPath: ownerPath,
                  statements,
                  nextIndex: i + 1,
                },
                ...nested.parents,
              ],
            };
          }
        }
      }
    }
  }
  return null;
}
