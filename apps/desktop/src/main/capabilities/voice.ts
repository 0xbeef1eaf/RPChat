/** `sdk.voice`: TTS through the `tts` template (or the hidden window's speechSynthesis), STT through `stt`. */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ActionContext, CapabilityHandler, Json } from '@rp/shared';
import { RpError, assetUrl } from '@rp/shared';
import type { CommandRunner } from './commands-runner.js';
import { commandFailed, notConfigured } from '../commands.js';
import type { OverlayWindowLike } from '../display/backend.js';

/** Synthetic pack id under which generated speech files are served to the audio window. */
export const TTS_PACK_ID = 'app.rp-code.tts';
export const VOICE_TEXT_MAX = 2000;
export const LISTEN_MAX_SECONDS = 60;
/** How long a fire-and-forget `speak()` waits for the TTS command to fail before reporting success. */
export const SPEAK_START_GRACE_MS = 300;

export interface VoiceHandlerDeps {
  commands: CommandRunner;
  audioWindow(): OverlayWindowLike;
  /** Directory registered as the root of `TTS_PACK_ID` for the asset protocol. */
  ttsDir: string;
  logger: Pick<Console, 'warn' | 'debug'>;
  /** Override of `SPEAK_START_GRACE_MS` for tests. */
  startGraceMs?: number;
}

export function speechSynthesisScript(text: string, rate: number | undefined, voice: string | undefined): string {
  const payload = JSON.stringify({ text, rate, voice });
  return `(function(){try{var p=${payload};if(!window.speechSynthesis)return false;var u=new SpeechSynthesisUtterance(p.text);if(p.rate)u.rate=p.rate;if(p.voice){var v=speechSynthesis.getVoices().find(function(x){return x.name===p.voice});if(v)u.voice=v;}speechSynthesis.cancel();speechSynthesis.speak(u);return true;}catch(e){return false;}})();`;
}

export class VoiceHandler implements CapabilityHandler {
  readonly moduleId = 'voice';
  private current: { abort: AbortController; itemId?: string } | undefined;

  constructor(private readonly deps: VoiceHandlerDeps) {}

  async invoke(method: string, args: Json[], _context: ActionContext): Promise<Json | void> {
    switch (method) {
      case 'speak':
        await this.speak(args[0], asObject(args[1]));
        return;
      case 'stop':
        await this.stop();
        return;
      case 'listen':
        return (await this.listen(asObject(args[0]))) as unknown as Json;
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.voice.${method}`);
    }
  }

  private async speak(textArg: unknown, opts: Record<string, unknown>): Promise<void> {
    if (typeof textArg !== 'string' || textArg.trim().length === 0) throw new RpError('INVALID_ARGUMENT', 'text must be a non-empty string');
    const text = textArg.trim().slice(0, VOICE_TEXT_MAX);
    const rate = typeof opts.rate === 'number' && opts.rate > 0 ? Math.min(4, opts.rate) : undefined;
    const voice = typeof opts.voice === 'string' ? opts.voice : undefined;
    const wait = opts.wait === true;
    await this.stop();
    const abort = new AbortController();
    this.current = { abort };
    const tpl = await this.deps.commands.resolve('tts');
    if (tpl.command.trim().length > 0) {
      const writesFile = tpl.command.includes('{file}');
      const file = path.join(this.deps.ttsDir, `${randomUUID()}.wav`);
      if (writesFile) await fs.mkdir(this.deps.ttsDir, { recursive: true });
      const vars: Record<string, string> = { text, file, rate: rate !== undefined ? String(rate) : '', voice: voice ?? '' };
      const run = this.deps.commands.runTemplate(tpl, vars, 'tts', { signal: abort.signal }).then(async (result) => {
        if (result.code !== 0 && !abort.signal.aborted) throw commandFailed('tts', tpl, result);
        if (writesFile && !abort.signal.aborted) await this.play(file, wait, abort);
      });
      if (wait || writesFile) await run;
      else {
        // Fire-and-forget, but a command that cannot start (missing binary) or fails at once is still reported.
        const settled = run.then(() => 'ok' as const);
        settled.catch((err) => this.deps.logger.warn('[voice] tts failed', err));
        await Promise.race([settled, new Promise<'pending'>((r) => setTimeout(() => r('pending'), this.deps.startGraceMs ?? SPEAK_START_GRACE_MS).unref?.())]);
      }
      return;
    }
    // Fallback: the hidden audio window's speechSynthesis.
    const win = this.deps.audioWindow();
    await win.whenReady();
    const ok = await win.runScript?.(speechSynthesisScript(text, rate, voice));
    if (ok !== true) {
      throw new RpError('CAPABILITY_FAILED', `${notConfigured('tts').message}; the built-in speech synthesis is unavailable here too`, { template: 'tts' });
    }
    if (wait) await new Promise((r) => setTimeout(r, Math.min(60_000, 400 + text.length * 60)));
  }

  private async play(file: string, wait: boolean, abort: AbortController): Promise<void> {
    const win = this.deps.audioWindow();
    await win.whenReady();
    const id = `tts-${randomUUID()}`;
    if (this.current) this.current.itemId = id;
    const url = assetUrl(TTS_PACK_ID, path.basename(file));
    const done = new Promise<void>((resolve) => {
      const off = win.onReport((ev) => {
        if (ev.id !== id) return;
        if (ev.type === 'ended' || ev.type === 'closed' || ev.type === 'error') {
          off();
          resolve();
        }
      });
      abort.signal.addEventListener('abort', () => {
        off();
        resolve();
      }, { once: true });
      setTimeout(() => {
        off();
        resolve();
      }, 120_000).unref?.();
    });
    win.send({ type: 'play-audio', id, url, options: {} });
    const cleanup = (): void => {
      void fs.rm(file, { force: true }).catch(() => undefined);
    };
    if (wait) {
      await done;
      cleanup();
    } else void done.then(cleanup);
  }

  private async stop(): Promise<void> {
    const current = this.current;
    this.current = undefined;
    if (!current) return;
    current.abort.abort();
    const win = this.deps.audioWindow();
    if (current.itemId && !win.isDestroyed()) win.send({ type: 'close', id: current.itemId });
    await win.runScript?.('(function(){try{if(window.speechSynthesis)speechSynthesis.cancel();}catch(e){}})();').catch(() => undefined);
  }

  private async listen(opts: Record<string, unknown>): Promise<{ text: string }> {
    const seconds = typeof opts.maxSeconds === 'number' && opts.maxSeconds > 0 ? Math.min(LISTEN_MAX_SECONDS, Math.round(opts.maxSeconds)) : 10;
    const result = await this.deps.commands.runChecked('stt', { seconds: String(seconds) });
    return { text: result.stdout.trim() };
  }

  async dispose(): Promise<void> {
    await this.stop();
  }
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
