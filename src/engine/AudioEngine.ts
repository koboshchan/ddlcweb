import { OggVorbisDecoder } from "@wasm-audio-decoders/ogg-vorbis";
import type { AudioDef } from "../types/game-data";
import type { AssetLoader } from "./AssetLoader";

export type AudioChannelName = "music" | "music_poem" | "sound" | "sfx";

interface ActiveChannel {
  source: AudioBufferSourceNode;
  gain: GainNode;
  trackKey: string;
  spec: AudioDef;
  startedAt: number;
  startOffset: number;
  duration: number;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
}

const AUDIO_TAG_RE = /^<([^>]+)>(.+)$/;
const AUDIO_TOKEN_RE = /\b(from|to|loop)\s+([0-9]+(?:\.[0-9]+)?)\b/g;

/**
 * Sample-accurate Web Audio API engine matching Ren'Py's audio channels,
 * `get_pos()`, `queue music`, and `<from X to Y loop Z>` loop directives.
 * Falls back automatically to WASM Ogg Vorbis decoding on browsers lacking
 * native `.ogg` support.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private readonly masterGain = new Map<AudioChannelName, GainNode>();
  private readonly volumes: Record<AudioChannelName, number> = {
    music: 0.8,
    music_poem: 0.8,
    sound: 0.9,
    sfx: 0.9,
  };
  private readonly active = new Map<AudioChannelName, ActiveChannel>();
  private readonly queued = new Map<AudioChannelName, string[]>();
  private readonly bufferCache = new Map<string, AudioBuffer>();
  private readonly dynamicAliases = new Map<string, AudioDef>();
  private vorbisDecoder: OggVorbisDecoder | null = null;

  public constructor(
    private readonly assets: AssetLoader,
    private readonly audioDefs: Record<string, AudioDef>,
  ) {}

  public isUnlocked(): boolean {
    return this.ctx !== null && this.ctx.state === "running";
  }

  public async unlock(): Promise<void> {
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      this.ctx = new AudioCtx();
      this.initChannelGains();
    }
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
  }

  private initChannelGains(): void {
    if (!this.ctx) {
      return;
    }
    const channels: AudioChannelName[] = ["music", "music_poem", "sound", "sfx"];
    for (const ch of channels) {
      const gain = this.ctx.createGain();
      gain.gain.value = this.volumes[ch];
      gain.connect(this.ctx.destination);
      this.masterGain.set(ch, gain);
    }
  }

  public setVolume(channel: AudioChannelName, volume: number): void {
    const clamped = Math.max(0, Math.min(1, volume));
    this.volumes[channel] = clamped;
    const node = this.masterGain.get(channel);
    if (node && this.ctx) {
      node.gain.setTargetAtTime(clamped, this.ctx.currentTime, 0.02);
    }
  }

  public getVolume(channel: AudioChannelName): number {
    return this.volumes[channel];
  }

  public setAlias(alias: string, specStr: string): void {
    this.dynamicAliases.set(alias, parseAudioSpec(specStr));
  }

  public getAliasRaw(alias: string): string | undefined {
    return this.dynamicAliases.get(alias)?.raw ?? this.audioDefs[alias]?.raw;
  }

  public resolveSpec(trackOrRaw: string): AudioDef {
    const cleaned = trackOrRaw.replace(/^audio\./, "");
    const dyn = this.dynamicAliases.get(cleaned);
    if (dyn) {
      return dyn;
    }
    const def = this.audioDefs[cleaned];
    if (def) {
      return def;
    }
    return parseAudioSpec(trackOrRaw);
  }

  public getPosition(channel: AudioChannelName = "music"): number {
    const active = this.active.get(channel);
    if (!active || !this.ctx) {
      return 0;
    }
    const elapsed = Math.max(0, this.ctx.currentTime - active.startedAt);
    const rawPos = active.startOffset + elapsed;
    if (!active.loop || active.loopEnd <= active.loopStart) {
      return Math.min(rawPos, active.duration);
    }
    if (rawPos < active.loopEnd) {
      return rawPos;
    }
    const loopLen = active.loopEnd - active.loopStart;
    return active.loopStart + ((rawPos - active.loopStart) % loopLen);
  }

  public getPlaying(channel: AudioChannelName = "music"): string | null {
    return this.active.get(channel)?.trackKey ?? null;
  }

  private async decodeBuffer(assetPath: string): Promise<AudioBuffer> {
    await this.unlock();
    if (!this.ctx) {
      throw new Error("AudioContext unavailable");
    }

    const cached = this.bufferCache.get(assetPath);
    if (cached) {
      return cached;
    }

    const url = this.assets.getAssetUrl(assetPath);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch audio ${assetPath}: ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();

    try {
      const decoded = await this.ctx.decodeAudioData(arrayBuffer.slice(0));
      this.bufferCache.set(assetPath, decoded);
      return decoded;
    } catch {
      const fallback = await this.decodeWithWasmVorbis(new Uint8Array(arrayBuffer));
      this.bufferCache.set(assetPath, fallback);
      return fallback;
    }
  }

  private async decodeWithWasmVorbis(bytes: Uint8Array): Promise<AudioBuffer> {
    if (!this.ctx) {
      throw new Error("AudioContext unavailable");
    }
    if (!this.vorbisDecoder) {
      this.vorbisDecoder = new OggVorbisDecoder();
      await this.vorbisDecoder.ready;
    }
    await this.vorbisDecoder.reset();
    const { channelData, samplesDecoded, sampleRate } =
      await this.vorbisDecoder.decodeFile(bytes);

    const buffer = this.ctx.createBuffer(
      channelData.length,
      samplesDecoded,
      sampleRate,
    );
    for (let i = 0; i < channelData.length; i++) {
      buffer.copyToChannel(new Float32Array(channelData[i]), i);
    }
    return buffer;
  }

  public queueTrack(channel: AudioChannelName, trackOrRaw: string): void {
    const list = this.queued.get(channel) ?? [];
    list.push(trackOrRaw);
    this.queued.set(channel, list);
    if (!this.active.has(channel)) {
      const next = list.shift();
      if (next) {
        void this.play(channel, next);
      }
    }
  }

  public async play(
    channel: AudioChannelName,
    trackOrRaw: string,
    options?: {
      fadein?: number;
      loop?: boolean;
      clearQueue?: boolean;
    },
  ): Promise<void> {
    if (options?.clearQueue !== false) {
      this.queued.delete(channel);
    }
    const spec = this.resolveSpec(trackOrRaw);
    const buffer = await this.decodeBuffer(spec.path);
    if (!this.ctx) {
      return;
    }

    this.stop(channel, 0, false);

    const channelGain = this.masterGain.get(channel);
    if (!channelGain) {
      return;
    }

    const trackGain = this.ctx.createGain();
    const fadein = options?.fadein ?? 0;
    const now = this.ctx.currentTime;
    if (fadein > 0) {
      trackGain.gain.setValueAtTime(0.0001, now);
      trackGain.gain.linearRampToValueAtTime(1.0, now + fadein);
    } else {
      trackGain.gain.setValueAtTime(1.0, now);
    }
    trackGain.connect(channelGain);

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(trackGain);

    const hasQueue = (this.queued.get(channel)?.length ?? 0) > 0;
    const shouldLoop =
      options?.loop ??
      (!hasQueue &&
        (channel === "music" ||
          channel === "music_poem" ||
          spec.loop !== undefined));

    const loopStart = spec.loop ?? 0;
    const loopEnd = spec.to ?? buffer.duration;
    const startOffset = Math.min(spec.from ?? 0, Math.max(0, buffer.duration - 0.01));

    source.loop = shouldLoop;
    if (shouldLoop) {
      source.loopStart = loopStart;
      source.loopEnd = loopEnd;
    }

    const record: ActiveChannel = {
      source,
      gain: trackGain,
      trackKey: trackOrRaw,
      spec,
      startedAt: now,
      startOffset,
      duration: buffer.duration,
      loop: shouldLoop,
      loopStart,
      loopEnd,
    };

    source.onended = () => {
      if (this.active.get(channel) === record) {
        this.active.delete(channel);
        const queue = this.queued.get(channel);
        const nextTrack = queue?.shift();
        if (nextTrack) {
          void this.play(channel, nextTrack, { clearQueue: false });
        }
      }
    };

    if (!shouldLoop && spec.to !== undefined && spec.to > startOffset) {
      source.start(now, startOffset, spec.to - startOffset);
    } else {
      source.start(now, startOffset);
    }

    this.active.set(channel, record);
  }

  public stopAll(fadeout = 0): void {
    for (const ch of ["music", "music_poem", "sound", "sfx"] as const) {
      this.stop(ch, fadeout);
    }
  }

  public stop(channel: AudioChannelName, fadeout = 0, clearQueue = true): void {
    if (clearQueue) {
      this.queued.delete(channel);
    }
    const current = this.active.get(channel);
    if (!current || !this.ctx) {
      return;
    }
    this.active.delete(channel);

    const now = this.ctx.currentTime;
    if (fadeout > 0) {
      current.gain.gain.cancelScheduledValues(now);
      current.gain.gain.setValueAtTime(current.gain.gain.value, now);
      current.gain.gain.linearRampToValueAtTime(0.0001, now + fadeout);
      window.setTimeout(() => {
        try {
          current.source.stop();
        } catch {
          // Source already stopped.
        }
      }, Math.ceil(fadeout * 1000) + 20);
    } else {
      try {
        current.source.stop();
      } catch {
        // Source already stopped.
      }
    }
  }
}

export function parseAudioSpec(raw: string): AudioDef {
  const trimmed = raw.trim();
  const match = AUDIO_TAG_RE.exec(trimmed);
  if (!match) {
    return {
      raw: trimmed,
      path: trimmed,
    };
  }

  const tagsStr = match[1];
  const pathStr = match[2].trim();
  const result: AudioDef = {
    raw: trimmed,
    path: pathStr,
  };

  AUDIO_TOKEN_RE.lastIndex = 0;
  let token = AUDIO_TOKEN_RE.exec(tagsStr);
  while (token !== null) {
    const key = token[1] as "from" | "to" | "loop";
    result[key] = parseFloat(token[2]);
    token = AUDIO_TOKEN_RE.exec(tagsStr);
  }
  return result;
}
