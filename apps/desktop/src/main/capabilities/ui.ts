/** `sdk.ui`: OS notifications, and confirm/choose modals answered in the main window. */
import { randomUUID } from 'node:crypto';
import { BrowserWindow, Notification, dialog } from 'electron';
import type { ActionContext, CapabilityHandler, Json, UiPromptAnswer, UiPromptRequest } from '@rp/shared';
import { RpError } from '@rp/shared';
import type { Logger } from '@rp/core';
import type { PendingPrompts } from '../prompts.js';

export const NOTIFY_TITLE_MAX = 100;
export const NOTIFY_BODY_MAX = 300;
export const CHOOSE_MIN_OPTIONS = 2;
export const CHOOSE_MAX_OPTIONS = 10;

export interface UiHandlerDeps {
  prompts: PendingPrompts<UiPromptAnswer>;
  /** Deliver a prompt to the main window; false when there is no window. */
  deliver(request: UiPromptRequest): boolean;
  characterName(context: ActionContext): string;
  logger: Logger;
  /** Injectable for tests. */
  notify?: (title: string, body: string) => void;
  /** Native pickers (Electron `dialog`); injectable for tests. */
  pickFiles?: (opts: { title?: string; filters?: Array<{ name: string; extensions: string[] }>; multiple?: boolean }) => Promise<string[] | null>;
  pickFolder?: (opts: { title?: string }) => Promise<string | null>;
}

function clip(v: unknown, max: number, what: string): string {
  if (typeof v !== 'string') throw new RpError('INVALID_ARGUMENT', `${what} must be a string`);
  const text = v.trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export class UiHandler implements CapabilityHandler {
  readonly moduleId = 'ui';

  constructor(private readonly deps: UiHandlerDeps) {}

  async invoke(method: string, args: Json[], context: ActionContext): Promise<Json | void> {
    switch (method) {
      case 'notify': {
        const title = clip(args[0], NOTIFY_TITLE_MAX, 'title');
        if (title.length === 0) throw new RpError('INVALID_ARGUMENT', 'title must not be empty');
        const body = args[1] === undefined || args[1] === null ? '' : clip(args[1], NOTIFY_BODY_MAX, 'body');
        this.notify(title, body);
        return;
      }
      case 'confirm': {
        const question = clip(args[0], 1000, 'question');
        const answer = await this.ask({ kind: 'confirm', question }, context);
        return answer === true;
      }
      case 'choose': {
        const question = clip(args[0], 1000, 'question');
        const options = args[1];
        if (!Array.isArray(options) || options.length < CHOOSE_MIN_OPTIONS || options.length > CHOOSE_MAX_OPTIONS) {
          throw new RpError('INVALID_ARGUMENT', `options must be an array of ${CHOOSE_MIN_OPTIONS} to ${CHOOSE_MAX_OPTIONS} strings`);
        }
        const labels = options.map((o) => clip(o, 120, 'option'));
        const answer = await this.ask({ kind: 'choose', question, options: labels }, context);
        return typeof answer === 'string' && labels.includes(answer) ? answer : null;
      }
      case 'ask': {
        const question = clip(args[0], 1000, 'question');
        const o = (args[1] && typeof args[1] === 'object' && !Array.isArray(args[1]) ? args[1] : {}) as Record<string, unknown>;
        const answer = await this.ask(
          {
            kind: 'text',
            question,
            ...(typeof o['placeholder'] === 'string' ? { placeholder: o['placeholder'].slice(0, 200) } : {}),
            ...(typeof o['defaultValue'] === 'string' ? { defaultValue: o['defaultValue'].slice(0, 4000) } : {}),
            ...(o['multiline'] === true ? { multiline: true } : {}),
          },
          context,
        );
        return typeof answer === 'string' ? answer.trim().slice(0, 4000) : null;
      }
      case 'pickFile': {
        const o = (args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] : {}) as Record<string, unknown>;
        const filters = Array.isArray(o['filters'])
          ? (o['filters'] as unknown[]).flatMap((f) => {
              if (!f || typeof f !== 'object') return [];
              const r = f as Record<string, unknown>;
              if (typeof r['name'] !== 'string' || !Array.isArray(r['extensions'])) return [];
              return [{ name: r['name'], extensions: (r['extensions'] as unknown[]).filter((e): e is string => typeof e === 'string') }];
            })
          : undefined;
        const picker = this.deps.pickFiles ?? defaultPickFiles;
        const result = await picker({
          ...(typeof o['title'] === 'string' ? { title: o['title'].slice(0, 200) } : {}),
          ...(filters ? { filters } : {}),
          ...(o['multiple'] === true ? { multiple: true } : {}),
        });
        return result;
      }
      case 'pickFolder': {
        const o = (args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] : {}) as Record<string, unknown>;
        const picker = this.deps.pickFolder ?? defaultPickFolder;
        return picker({ ...(typeof o['title'] === 'string' ? { title: o['title'].slice(0, 200) } : {}) });
      }
      default:
        throw new RpError('CAPABILITY_UNKNOWN', `Unknown method sdk.ui.${method}`);
    }
  }

  private notify(title: string, body: string): void {
    if (this.deps.notify) {
      this.deps.notify(title, body);
      return;
    }
    if (!Notification.isSupported()) {
      this.deps.logger.info(`[ui] notification (unsupported here): ${title} — ${body}`);
      return;
    }
    new Notification({ title, body, silent: false }).show();
  }

  private ask(partial: Pick<UiPromptRequest, 'kind' | 'question' | 'options' | 'placeholder' | 'defaultValue' | 'multiline'>, context: ActionContext): Promise<UiPromptAnswer> {
    const request: UiPromptRequest = {
      promptId: randomUUID(),
      sessionId: context.sessionId,
      characterName: this.deps.characterName(context),
      ...partial,
    };
    return this.deps.prompts.ask(request.promptId, () => this.deps.deliver(request));
  }
}

async function defaultPickFiles(opts: { title?: string; filters?: Array<{ name: string; extensions: string[] }>; multiple?: boolean }): Promise<string[] | null> {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible());
  const options: Electron.OpenDialogOptions = {
    ...(opts.title ? { title: opts.title } : {}),
    ...(opts.filters ? { filters: opts.filters } : {}),
    properties: opts.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
  };
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths;
}

async function defaultPickFolder(opts: { title?: string }): Promise<string | null> {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible());
  const options: Electron.OpenDialogOptions = { ...(opts.title ? { title: opts.title } : {}), properties: ['openDirectory'] };
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  return result.canceled || result.filePaths.length === 0 ? null : (result.filePaths[0] ?? null);
}
