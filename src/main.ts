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
import { Persistence } from "./engine/Persistence";
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

async function runIntroSplash(
  scene: SceneManager,
  modals: ModalScreens,
  persistence: Persistence,
): Promise<void> {
  if (!persistence.data.first_run) {
    await scene.setScene("white");
    await modals.showTermsOfService();
    persistence.data.first_run = true;
    persistence.savePersistent();
  }

  // Team Salvato splash (`bg/splash.png`)
  await scene.setScene("bg/splash.png");
  await scene.runTransition("Dissolve(0.5, alpha=True)");
  await new Promise((r) => window.setTimeout(r, 1200));
  await scene.setScene("white");
  await scene.runTransition("Dissolve(0.5, alpha=True)");

  // `s_kill_early` easter egg: if sayori.chr is missing at the start of Act 1
  if (persistence.data.playthrough === 0 && !persistence.data.seen_ghost_menu) {
    // Check handled dynamically in splash/main menu
  }

  // 1/64 Ghost Menu easter egg during Act 2
  if (
    persistence.data.playthrough === 2 &&
    !persistence.data.seen_ghost_menu &&
    Math.floor(Math.random() * 64) === 0
  ) {
    persistence.data.ghost_menu = true;
    persistence.data.seen_ghost_menu = true;
    persistence.savePersistent();
  }
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
  const modals = new ModalScreens(stage.uiRoot, assets, audio);
  const poemView = new PoemViewScreen(stage.uiRoot, assets);
  const vfsDrawer = new VirtualFilesDrawer(stage.uiRoot, vfs);

  const audioPill = document.createElement("button");
  audioPill.type = "button";
  audioPill.className = "ddlc-status-pill";
  audioPill.textContent = "Click to Enable Audio";
  stage.uiRoot.appendChild(audioPill);

  let vm: ScriptVM | null = null;
  let titleScreen: TitleScreen | null = null;
  let gameMenu: GameMenuScreen | null = null;
  let inGame = false;

  const returnToTitle = (): void => {
    inGame = false;
    vm?.stop();
    stage.clearSceneLayers();
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
    stage.clearSceneLayers();
    vm?.resetVariables();
    inGame = true;
    const entryLabel = label ?? "start";
    void vm?.runFromLabel(entryLabel);
  };

  const dialogue = new DialogueOverlay(stage.uiRoot, assets, audio, persistence, {
    onOpenHistory: () => gameMenu?.open("history", true),
    onOpenSave: () => gameMenu?.open("save", true),
    onOpenLoad: () => gameMenu?.open("load", true),
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
      void startNewGameFlow(label);
    },
  });

  const poemGame = new PoemGameScreen(
    stage.uiRoot,
    manifest.poemWords,
    assets,
    audio,
    scene,
    persistence,
    vm.py,
    modals,
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
        inGame = true;
        await vm!.restoreFromSaveSlot(slot);
      },
      onRestartNewGame: () => {
        void startNewGameFlow("start");
      },
      onMainMenu: returnToTitle,
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
  });

  // Check `s_kill_early` easter egg if sayori.chr was deleted before starting Act 1
  if (
    persistence.data.playthrough === 0 &&
    !vfs.exists("characters/sayori.chr")
  ) {
    inGame = true;
    await vm.runFromLabel("s_kill_early");
    return;
  }

  // Resume `autoload` states (Act 3 Monika `ch30_autoload`, `credits`, `postcredits_loop`)
  if (persistence.data.autoload) {
    inGame = true;
    await vm.runFromLabel(persistence.data.autoload);
    return;
  }

  await runIntroSplash(scene, modals, persistence);
  await titleScreen.show();
}

void bootstrap().catch((err) => {
  console.error("[ddlcweb] Fatal startup error:", err);
});
