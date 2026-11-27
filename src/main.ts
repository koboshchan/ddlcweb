import "./styles/main.css";
import {
  audioDefs,
  characterDefs,
  defaultDefs,
  imageDefs,
  loadScriptModule,
  manifest,
  poemDefs,
  scriptIndex,
  transformDefs,
} from "./generated";
import { AssetLoader } from "./engine/AssetLoader";
import { AudioEngine } from "./engine/AudioEngine";
import { Persistence, QUICK_SAVE_SLOT } from "./engine/Persistence";
import { SceneManager } from "./engine/SceneManager";
import { ScriptVM } from "./engine/ScriptVM";
import { Stage } from "./engine/Stage";
import { VirtualFS } from "./engine/VirtualFS";
import { DialogueOverlay } from "./ui/DialogueOverlay";
import { GameMenuScreen } from "./ui/GameMenuScreen";
import { ModalScreens } from "./ui/ModalScreens";
import { PoemGameScreen } from "./ui/PoemGameScreen";
import { PoemViewScreen } from "./ui/PoemViewScreen";
import { TitleScreen } from "./ui/TitleScreen";
import { VirtualFilesDrawer } from "./ui/VirtualFilesDrawer";

const ACT2_SPLASH_MESSAGES = [
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
];

async function runIntroSplash(
  scene: SceneManager,
  audio: AudioEngine,
  modals: ModalScreens,
  persistence: Persistence,
): Promise<void> {
  if (!persistence.data.first_run) {
    await scene.setScene("white");
    await modals.showTermsOfService();
    persistence.data.first_run = true;
    persistence.savePersistent();
  }

  // 1/64 Ghost Menu easter egg during Act 2 (matches `splash.rpy`: skips normal splash)
  if (
    persistence.data.playthrough === 2 &&
    !persistence.data.seen_ghost_menu &&
    Math.floor(Math.random() * 64) === 0
  ) {
    persistence.data.ghost_menu = true;
    persistence.data.seen_ghost_menu = true;
    persistence.savePersistent();
    await scene.setScene("black");
    void audio.play("music", "ghostmenu").catch(() => {});
    await new Promise((r) => window.setTimeout(r, 1000));
    await scene.show("end");
    await scene.runTransition("dissolve_cg");
    await new Promise((r) => window.setTimeout(r, 3000));
    return;
  }

  if (persistence.data.ghost_menu) {
    persistence.data.ghost_menu = false;
    persistence.savePersistent();
  }

  // Team Salvato splash (`bg/splash.png`, 0.5s in, 2.5s hold, 0.5s out)
  await scene.setScene("white");
  await scene.setScene("bg/splash.png");
  await scene.runTransition("Dissolve(0.5, alpha=True)");
  await new Promise((r) => window.setTimeout(r, 2500));
  await scene.setScene("white");
  await scene.runTransition("Dissolve(0.5, alpha=True)");

  // Content warning splash (`splash_warning`, 0.5s in, 2.0s hold, 0.5s out)
  let warningText =
    "This game is not suitable for children\nor those who are easily disturbed.";
  if (
    persistence.data.playthrough === 2 &&
    Math.floor(Math.random() * 4) === 0
  ) {
    warningText =
      ACT2_SPLASH_MESSAGES[
        Math.floor(Math.random() * ACT2_SPLASH_MESSAGES.length)
      ];
  }
  await scene.show("splash_warning", [], { paramText: warningText });
  await scene.runTransition("Dissolve(0.5, alpha=True)");
  await new Promise((r) => window.setTimeout(r, 2000));
  await scene.hide("splash_warning");
  await scene.runTransition("Dissolve(0.5, alpha=True)");
}

async function bootstrap(): Promise<void> {
  const stage = await Stage.create();
  const assets = new AssetLoader(manifest, imageDefs);
  await assets.loadFonts();

  const audio = new AudioEngine(assets, audioDefs);
  const persistence = new Persistence();
  audio.setVolume("music", persistence.data.preferences.musicVolume);
  audio.setVolume("music_poem", persistence.data.preferences.musicVolume);
  audio.setVolume("sound", persistence.data.preferences.sfxVolume);
  audio.setVolume("sfx", persistence.data.preferences.sfxVolume);

  const vfs = new VirtualFS(manifest.characterFiles);
  const scene = new SceneManager(stage, assets, transformDefs);

  let dialogue: DialogueOverlay | null = null;
  const modals = new ModalScreens(stage.uiRoot, assets, audio, (open) => {
    dialogue?.setOverlayOpen("modal", open);
  });
  const poemView = new PoemViewScreen(stage.uiRoot, assets);
  const vfsDrawer = new VirtualFilesDrawer(stage.uiRoot, vfs, (open) => {
    dialogue?.setOverlayOpen("vfs", open);
  });

  const audioPill = document.createElement("button");
  audioPill.type = "button";
  audioPill.className = "ddlc-status-pill";
  audioPill.textContent = "Click to Enable Audio";
  stage.uiRoot.appendChild(audioPill);

  let vm: ScriptVM | null = null;
  let titleScreen: TitleScreen | null = null;
  let gameMenu: GameMenuScreen | null = null;
  let poemGame: PoemGameScreen | null = null;
  let inGame = false;

  const returnToTitle = (): void => {
    inGame = false;
    poemGame?.hide();
    vm?.stop();
    scene.resetAllLayers();
    void titleScreen?.show();
  };

  const startNewGameFlow = async (label?: string): Promise<void> => {
    if (!label && !persistence.data.playername) {
      const entered = await modals.showNameInput("Please enter your name");
      if (!entered) {
        return;
      }
      persistence.data.playername = entered;
      persistence.savePersistent();
    }
    titleScreen?.hide();
    poemGame?.hide();
    scene.resetAllLayers();
    vm?.resetVariables();
    inGame = true;
    const entryLabel = label ?? "start";
    void vm?.runFromLabel(entryLabel);
  };

  const handleQuickSave = async (): Promise<void> => {
    if (!inGame || !vm) {
      return;
    }
    if (persistence.data.playthrough === 3) {
      await modals.showDialog(
        "There's no point in saving anymore.\nDon't worry, I'm not going anywhere.",
      );
      return;
    }
    const snapshot = vm.captureSaveSlot(QUICK_SAVE_SLOT);
    persistence.writeSlot(snapshot);
    modals.showNotify("Quick Save complete.");
  };

  const handleQuickLoad = async (): Promise<void> => {
    if (!vm) {
      return;
    }
    const slot = persistence.readSlot(QUICK_SAVE_SLOT);
    if (
      persistence.data.playthrough === 1 &&
      !persistence.data.deleted_saves &&
      slot !== null
    ) {
      await modals.showDialog(
        'File error: "characters/sayori.chr"\n\nThe file is missing or corrupt.',
      );
      await modals.showDialog(
        "The save file is corrupt. Starting a new game.",
      );
      void startNewGameFlow("start");
      return;
    }
    if (!slot) {
      modals.showNotify("No quick save found.");
      return;
    }
    titleScreen?.hide();
    poemGame?.hide();
    inGame = true;
    modals.showNotify("Quick Load complete.");
    void vm.restoreFromSaveSlot(slot);
  };

  dialogue = new DialogueOverlay(stage.uiRoot, assets, audio, persistence, {
    onOpenHistory: () => gameMenu?.open("history", true),
    onOpenSave: () => gameMenu?.open("save", true),
    onOpenLoad: () => gameMenu?.open("load", true),
    onQuickSave: () => {
      void handleQuickSave();
    },
    onQuickLoad: () => {
      void handleQuickLoad();
    },
    onOpenSettings: () => gameMenu?.open("settings", true),
    onOpenVirtualFiles: () => vfsDrawer.show(),
    onToggleSkip: (skipping) => modals.setSkipIndicator(skipping),
  });

  vm = new ScriptVM({
    stage,
    scriptIndex,
    loadScript: loadScriptModule,
    characters: characterDefs,
    defaults: defaultDefs,
    poems: poemDefs,
    scene,
    audio,
    dialogue,
    modals,
    poemView,
    persistence,
    vfs,
    onReturnToTitle: returnToTitle,
    onRestartAtLabel: (label) => {
      audio.stopAll();
      dialogue?.setSkipping(false);
      dialogue?.setAutoForward(false);
      void startNewGameFlow(label ?? "splashscreen");
    },
  });

  poemGame = new PoemGameScreen(
    stage.uiRoot,
    manifest.poemWords,
    assets,
    audio,
    scene,
    persistence,
    vm.py,
    modals,
    dialogue,
  );
  vm.attachPoemGame(poemGame);

  gameMenu = new GameMenuScreen(
    stage.uiRoot,
    assets,
    audio,
    persistence,
    vfs,
    modals,
    {
      onCaptureSaveData: (slot) => vm!.captureSaveSlot(slot),
      onLoadSaveSlot: async (slot) => {
        titleScreen?.hide();
        poemGame?.hide();
        inGame = true;
        await vm!.restoreFromSaveSlot(slot);
      },
      onRestartNewGame: () => {
        void startNewGameFlow("start");
      },
      onMainMenu: returnToTitle,
      onOpenChange: (open) => dialogue?.setOverlayOpen("gamemenu", open),
    },
  );

  const unlockAndPlayMenuMusic = async (): Promise<void> => {
    await audio.unlock();
    audioPill.classList.add("is-hidden");
    if (!inGame) {
      titleScreen?.tryPlayTitleMusic();
    }
  };

  audioPill.addEventListener("click", () => {
    void unlockAndPlayMenuMusic();
  });

  window.addEventListener(
    "pointerdown",
    () => {
      if (!audio.isUnlocked()) {
        void unlockAndPlayMenuMusic();
      }
    },
    { once: true },
  );

  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && inGame) {
      if (gameMenu?.isOpen()) {
        gameMenu.close();
      } else {
        gameMenu?.open("save", true);
      }
    }
  });

  titleScreen = new TitleScreen(stage, assets, audio, persistence, {
    onNewGame: () => {
      void startNewGameFlow();
    },
    onLoadGame: () => gameMenu?.open("load", false),
    onSettings: () => gameMenu?.open("settings", false),
    onAbout: () => gameMenu?.open("about", false),
    onOpenVirtualFiles: () => vfsDrawer.show(),
    onExitGhostMenu: () => {
      void (async () => {
        titleScreen?.hide();
        audio.stopAll();
        await scene.setScene("white");
        await scene.show("gui/menu_art_m_ghost.png", [], {
          atl: [
            {
              type: "step",
              properties: [
                ["xpos", "-100"],
                ["ypos", "-100"],
                ["zoom", "3.5"],
              ],
            },
          ],
        });
        await new Promise((r) => window.setTimeout(r, 150));
        persistence.data.ghost_menu = false;
        persistence.savePersistent();
        scene.resetAllLayers();
        await titleScreen?.show();
      })();
    },
  });

  // Check `s_kill_early` easter egg if sayori.chr was deleted before starting Act 1
  if (
    persistence.data.playthrough === 0 &&
    !vfs.exists("characters/sayori.chr")
  ) {
    inGame = true;
    await vm.runFromLabel("splashscreen");
    return;
  }

  // Resume `autoload` states (Act 2 `yuri_kill_2`, Act 3 `ch30_autoload`, `credits`, `postcredits_loop`)
  if (persistence.data.autoload) {
    inGame = true;
    await vm.runFromLabel("autoload");
    return;
  }

  await runIntroSplash(scene, audio, modals, persistence);
  await titleScreen.show();
}

void bootstrap().catch((err) => {
  console.error("[ddlcweb] Fatal startup error:", err);
});
