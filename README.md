# ddlcweb

An unofficial, near pixel-perfect web port project base for **Doki Doki Literature Club!**

> [!IMPORTANT]
> **No DDLC art, audio, fonts, scripts, or character files are included in this repository.**
> You must supply your own legally obtained copy of `ddlc-win.zip` (or `ddlc-mac.zip`, or an extracted DDLC folder) at build time.

## Architecture & Tech Stack

- **Renderer**: [PixiJS v8](https://pixijs.com/) (WebGL2 / WebGPU 2D scene graph) locked to DDLC's native **1280×720** logical coordinate space with crisp 16:9 letterboxing and GPU-live sprite compositing (`im.Composite` / `LiveComposite`), `TilingSprite` (`LiveTile`), `RenderTexture` captures, and custom GLSL fragment filters (`ImageDissolve`, `Tear`, `AnimatedMask`, color matrices).
- **UI & Typography**: Coordinate-locked **1280×720** HTML/CSS overlay synchronized with the PixiJS stage, loading DDLC's real extracted TrueType fonts (`Aller_Rg.ttf`, `RifficFree-Bold.ttf`, poem handwriting fonts, etc.) via `@font-face` for crisp Retina rendering and rich Ren'Py text tags.
- **Audio Engine**: **Web Audio API** multi-channel engine supporting sample-accurate Ren'Py loop directives (`<from X to Y loop Z>`), channel fades, and an automatic WASM Ogg Vorbis fallback (`@wasm-audio-decoders/ogg-vorbis`) for browsers without native `.ogg` decoding (such as Safari).
- **Extraction & Compilation Pipeline**: Pure **Python 3 standard library** (zero `pip` packages required). Reads `scripts.rpa`, `images.rpa`, `audio.rpa`, `fonts.rpa`, and `characters/*.chr` directly from `ddlc-win.zip` (or `ddlc-mac.zip`), safely unpickles `.rpyc` ASTs with an inert allowlist, and generates gitignored web assets in `public/game-assets/` and JSON manifests in `src/generated/`.
- **Virtual Filesystem**: Browser-persisted virtual `characters/` directory so inspecting, deleting, and restoring `.chr` files works without desktop filesystem access.

## Quick Start

### Prerequisites

- Node.js 20+ (with `npm`)
- Python 3.10+ (standard library only — no `pip install` needed)
- Your own legally obtained `ddlc-win.zip` (or `ddlc-mac.zip`) from [ddlc.moe](https://ddlc.moe)

### Install & Build

```bash
npm install

# Extract assets from ddlc-win.zip and build the production bundle into dist/
DDLC_ZIP=/path/to/ddlc-win.zip npm run build
```

### Local Development

```bash
# Extract assets once (cached by zip fingerprint) and start Vite dev server
DDLC_ZIP=/path/to/ddlc-win.zip npm run dev
```

You can also run asset extraction standalone:

```bash
python3 tools/prepare_assets.py /path/to/ddlc-win.zip
# Pass --force to re-extract and recompile
python3 tools/prepare_assets.py --force /path/to/ddlc-win.zip
```

## Verification & Repo Hygiene

```bash
# Run Python pipeline unit tests
npm test

# Type-check TypeScript
npm run typecheck

# Verify zero copyrighted DDLC assets or generated files are tracked in git
npm run check:clean
```

## Project Layout

```text
tools/
  extract_ddlc.py       Pure-Python RPA-3.0 + ZIP extractor (ddlc-win.zip / ddlc-mac.zip / dir)
  rpyc_ast.py           Safe allowlisted Ren'Py .rpyc AST reader
  compile_data.py       Compiles .rpyc ASTs -> src/generated/ JSON manifests
  prepare_assets.py     Cached build-time extraction orchestrator
  check_clean_repo.py   Git hygiene guardrail (blocks copyrighted files from git)
src/
  engine/               Stage (PixiJS v8), AssetLoader, AudioEngine, SceneManager, ScriptVM,
                        VirtualFS, Persistence, and GLSL shaders (ImageDissolveFilter)
  ui/                   TitleScreen, DialogueOverlay, TextParser, VirtualFilesDrawer
  types/                TypeScript schemas for compiled manifests
  styles/               1280x720 coordinate-locked UI styles
public/game-assets/     [gitignored] Extracted images, audio, fonts, and initial .chr files
src/generated/          [gitignored] Compiled JSON manifests & script ASTs
```

## License & IP Disclaimer

Original engine code and build tools are licensed under the MIT License (see [LICENSE](LICENSE)). Doki Doki Literature Club! and all associated assets belong to Team Salvato.
