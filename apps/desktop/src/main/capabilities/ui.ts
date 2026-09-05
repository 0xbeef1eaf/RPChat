/** `sdk.ui`: OS notifications, and confirm/choose modals answered in the main window. */
import { randomUUID } from 'node:crypto';
import { Notification } from 'electron';
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

  private ask(partial: Pick<UiPromptRequest, 'kind' | 'question' | 'options'>, context: ActionContext): Promise<UiPromptAnswer> {
    const request: UiPromptRequest = {
      promptId: randomUUID(),
      sessionId: context.sessionId,
      characterName: this.deps.characterName(context),
      ...partial,
    };
    return this.deps.prompts.ask(request.promptId, () => this.deps.deliver(request));
  }
}
