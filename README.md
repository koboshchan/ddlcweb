# ddlcweb

![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue)
![PixiJS](https://img.shields.io/badge/PixiJS-v8-ff69b4)
![Python](https://img.shields.io/badge/Python-3.10%2B_(stdlib)-yellow)
![License](https://img.shields.io/badge/License-MIT-green)

A near pixel-perfect web port of **Doki Doki Literature Club!** built with **PixiJS v8**, **Web Audio API**, **TypeScript**, **Vite**, and a pure-Python build-time asset extractor/compiler.

> [!IMPORTANT]
> **Bring your own legally obtained copy of DDLC.** No art, audio, fonts, scripts, or `.chr` files from *Doki Doki Literature Club!* are stored or distributed in this repository. At build time, you provide a path to your own `ddlc-win.zip` (or `ddlc-mac.zip`) and the toolchain extracts and compiles everything locally into gitignored directories.

## Features

- **Pure-Python Build Pipeline**: Extracts `scripts.rpa`, `images.rpa`, `audio.rpa`, `fonts.rpa`, and `characters/*.chr` directly from `ddlc-win.zip` or `ddlc-mac.zip` using only the Python 3 standard library (`zipfile`, `zlib`, allowlisted `pickle`, `ast`).
- **1280×720 Pixel-Locked Renderer**: Powered by [PixiJS v8](https://pixijs.com/) with GPU-live `im.Composite` / `LiveComposite` sprite assembly, `TilingSprite` backgrounds, `RenderTexture` captures, and custom GLSL fragment shaders (`ImageDissolve`, `Tear`, `Invert`, `AnimatedMask`).
- **Full Ren'Py Runtime & Python-AST VM**: Executes compiled `.rpyc` scripts and Python blocks (`PyRuntime`), including parameterized labels (`showpoem`, `updateconsole`), `ConditionSwitch`, `RigMouse`, `FileActionMod`, and all Act 1–4 / Ghost Menu / `s_kill_early` states.
- **Sample-Accurate Web Audio**: Multi-channel Web Audio engine supporting Ren'Py `<from X to Y loop Z>` loop points, fades, `get_pos()`, and automatic WASM Ogg Vorbis decoding (`@wasm-audio-decoders/ogg-vorbis`) for browsers without native `.ogg` support.
- **Complete UI & Minigames**: Animated Main Menu, first-run Terms of Service & splash, `name_input`, `DialogueOverlay` (with `edited` and `default_monika` styles, Skip, Auto, Quick Menu), 20-word Poem Minigame with bouncing chibi stickers, Poem Viewer with authentic handwriting fonts, Save/Load/History/Settings Game Menu, and an interactive in-browser `characters/` Virtual Filesystem drawer.
- **Docker Builder & Runner**: Multi-stage `Dockerfile` for containerized builds and zero-dependency static serving via Nginx.

## Prerequisites

- **Local builds**: Node.js 20+ (with `npm`) and Python 3.10+ (no `pip` packages required)
- **Containerized builds**: Docker 24+
- Your own copy of `ddlc-win.zip` (or `ddlc-mac.zip`) from [ddlc.moe](https://ddlc.moe)

## Quick Start

### Option 1: Local Development & Build

```bash
git clone https://github.com/koboshchan/ddlcweb.git
cd ddlcweb
npm install

# Extract assets from ddlc-win.zip and start the Vite dev server
DDLC_ZIP=/path/to/ddlc-win.zip npm run dev
```

To build a static production bundle into `dist/`:

```bash
DDLC_ZIP=/path/to/ddlc-win.zip npm run build
```

> [!TIP]
> Asset extraction is fingerprinted in `.cache/build-stamp.json`, so subsequent `npm run dev` or `npm run build` runs skip re-extraction until `ddlc-win.zip` changes. Pass `python3 tools/prepare_assets.py --force /path/to/ddlc-win.zip` to force a clean rebuild.

### Option 2: Docker Runner (Extract, Build & Serve via Nginx)

Build the runner image once (contains **zero** copyrighted DDLC assets):

```bash
docker build -t ddlcweb .
```

Mount your `ddlc-win.zip` at runtime and open `http://localhost:8080`:

```bash
docker run --rm -p 8080:80 \
  -v /path/to/ddlc-win.zip:/ddlc/ddlc-win.zip:ro \
  ddlcweb
```

To use the container strictly as a builder and export static `dist/` files to your host:

```bash
docker run --rm \
  -e BUILD_ONLY=1 \
  -v /path/to/ddlc-win.zip:/ddlc/ddlc-win.zip:ro \
  -v "$(pwd)/dist:/out" \
  ddlcweb
```

## Configuration & Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DDLC_ZIP` | — | Path to `ddlc-win.zip`, `ddlc-mac.zip`, or an extracted DDLC folder. |
| `DDLC_PATH` | — | Alternative environment variable alias for `DDLC_ZIP`. |
| `BUILD_ONLY` | `0` | In Docker `runner`, set to `1` to write compiled `dist/` files to `/out` and exit without starting Nginx. |

## Architecture & Project Layout

```text
tools/
  extract_ddlc.py       Pure-Python RPA-3.0 + ZIP extractor (ddlc-win.zip / ddlc-mac.zip / dir)
  rpyc_ast.py           Safe allowlisted Ren'Py .rpyc AST loader
  compile_data.py       Compiles .rpyc ASTs & Python blocks -> src/generated/ manifests
  prepare_assets.py     Cached build-time extraction orchestrator
  check_clean_repo.py   Git guardrail preventing copyrighted files from being committed
src/
  engine/
    Stage.ts            1280x720 PixiJS v8 canvas + aspect-locked DOM overlay
    AssetLoader.ts      Ren'Py path resolver, @font-face loader, live GPU composites
    AudioEngine.ts      Multi-channel Web Audio + WASM Ogg Vorbis fallback
    SceneManager.ts     Layers, character slots, ATL transforms, transitions
    SpecialEffects.ts   Tear, Invert, AnimatedMask GLSL filters & Blood emitter
    PyRuntime.ts        Async Python-AST interpreter + Ren'Py API shims
    ScriptVM.ts         Ren'Py script execution VM & save/load snapshots
    VirtualFS.ts        localStorage-backed virtual characters/ filesystem
    Persistence.ts      persistent & 6-slot save storage
  ui/                   TitleScreen, DialogueOverlay, PoemGameScreen, PoemViewScreen,
                        GameMenuScreen, ModalScreens, TextParser, VirtualFilesDrawer
  styles/main.css       1280x720 coordinate-locked UI styles
  types/game-data.ts    TypeScript schemas for compiled manifests
public/game-assets/     [gitignored] Extracted game art, audio, fonts, and .chr files
src/generated/          [gitignored] Compiled JSON manifests & script ASTs
dist/                   [gitignored] Vite production bundle
```

## Verification & Repo Hygiene

```bash
# Run Python pipeline unit tests
npm test

# Type-check TypeScript
npm run typecheck

# Verify zero DDLC assets or generated data are tracked in git
npm run check:clean
```

## License

Original engine code, shaders, UI, and build tools are licensed under the MIT License — see [LICENSE](LICENSE) for details and Team Salvato IP guidelines.
