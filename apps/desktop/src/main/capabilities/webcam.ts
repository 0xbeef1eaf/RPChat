/**
 * `sdk.webcam`: photos and short clips from the user's camera, written into the character's
 * own home directory (the same folder `sdk.files` exposes) and returned as an `AssetRef` with
 * `source: 'home'`. Capture itself is whatever the user's `webcamImage` / `webcamVideo` command
 * template does; this handler only picks the destination, runs it and checks that a file appeared.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ActionContext, CapabilityHandler, Json } from '@rp/shared';
import { RpError, characterRef } from '@rp/shared';
import type { AssetRef } from '@rp/core';
import { assetKindFor, mimeFor } from '@rp/pack';
import { notConfigured, templateLocation } from '../commands.js';
import type { CommandRunner } from './commands-runner.js';
import { characterHomeDir } from './files.js';

/** Folder inside the character home that captures are written to. */
export const WEBCAM_DIR = 'webcam';
export const WEBCAM_VIDEO_MIN_SECONDS = 1;
export const WEBCAM_VIDEO_MAX_SECONDS = 60;
/** Room over `seconds` for the command to start up and flush the file before we give up on it. */
const VIDEO_OVERHEAD_MS = 30_000;

export interface WebcamHandlerDeps {
  commands: CommandRunner;
  userData: string;
}

/** `webcam/2026-09-15T12-30-00-123Z-1a2b3c4d.jpg` — sorts chronologically and never collides. */
export function captureName(extension: string, now: Date = new Date(), id: string = randomUUID()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `${WEBCAM_DIR}/${stamp}-${id.slice(0, 8)}.${extension}`;
}

export function validateSeconds(value: unknown): number {
  const seconds = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(seconds)) throw new RpError('INVALID_ARGUMENT', 'seconds must be a number');
  const rounded = Math.round(seconds);
  if (rounded < WEBCAM_VIDEO_MIN_SECONDS || rounded > WEBCAM_VIDEO_MAX_SECONDS) {
    throw new RpError('INVALID_ARGUMENT', `seconds must be between ${WEBCAM_VIDEO_MIN_SECONDS} and ${WEBCAM_VIDEO_MAX_SECONDS}`);
  }
  return rounded;
}

export class WebcamHandler implements CapabilityHandler {
  readonly moduleId = 'webcam';

  constructor(private readonly deps: WebcamHandlerDeps) {}

  homeFor(context: ActionContext): string {
    return characterHomeDir(this.deps.userData, characterRef(context.packId, context.characterId));
  }

  async invoke(method: string, args: Json[], context: ActionContext): Promise<Json | void> {
    switch (method) {
      case 'takeImage':
        return (await this.capture(context, 'webcamImage', 'jpg', {})) as unknown as Json;
      case 'takeVideo': {
        const seconds = validateSeconds(args[0]);
        return (await this.capture(context, 'webcamVideo', 'mp4', { seconds: String(seconds) }, seconds * 1000 + VIDEO_OVERHEAD_MS)) as unknown as Json;
      }
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.webcam.${method}`);
    }
  }

  private async capture(
    context: ActionContext,
    template: 'webcamImage' | 'webcamVideo',
    extension: string,
    vars: Record<string, string>,
    timeoutMs?: number,
  ): Promise<AssetRef> {
    if (!(await this.deps.commands.isConfigured(template))) throw notConfigured(template);
    const relative = captureName(extension);
    const absolute = path.join(this.homeFor(context), relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });

    try {
      await this.deps.commands.runChecked(template, { ...vars, file: absolute }, timeoutMs === undefined ? {} : { timeoutMs });
    } catch (err) {
      await fs.rm(absolute, { force: true }).catch(() => undefined);
      throw err;
    }

    const stat = await fs.stat(absolute).catch(() => undefined);
    if (!stat?.isFile() || stat.size === 0) {
      await fs.rm(absolute, { force: true }).catch(() => undefined);
      throw new RpError(
        'CAPABILITY_FAILED',
        `The ${template === 'webcamImage' ? 'camera photo' : 'camera video'} command exited 0 but wrote no file; it must save to {file} — check it in ${templateLocation(template)}`,
        { template, file: absolute },
      );
    }
    return { source: 'home', path: relative, kind: assetKindFor(relative), mime: mimeFor(relative), bytes: stat.size, tags: [WEBCAM_DIR] };
  }
}
