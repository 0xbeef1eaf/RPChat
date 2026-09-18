import { describe, expect, it } from 'vitest';
import { channelForEditing, channelForSaving, channelSummary, splitTelegramUrl } from './messaging';

describe('splitTelegramUrl', () => {
  it('recovers the token and chat id from a full sendMessage endpoint', () => {
    expect(splitTelegramUrl('https://api.telegram.org/bot123:AA-bb/sendMessage?chat_id=-1001')).toEqual({ token: '123:AA-bb', chatId: '-1001' });
    expect(splitTelegramUrl('https://api.telegram.org/bot123:AA-bb/sendMessage')).toEqual({ token: '123:AA-bb', chatId: '' });
  });

  it('gives empty fields for anything it cannot read', () => {
    expect(splitTelegramUrl(undefined)).toEqual({ token: '', chatId: '' });
    expect(splitTelegramUrl('not a url')).toEqual({ token: '', chatId: '' });
    expect(splitTelegramUrl('https://api.telegram.org/sendMessage')).toEqual({ token: '', chatId: '' });
  });
});

describe('channelForEditing', () => {
  it('migrates a URL-only telegram channel onto the two fields', () => {
    expect(channelForEditing({ name: 't', kind: 'telegram', url: 'https://api.telegram.org/bot9:X/sendMessage?chat_id=5' })).toEqual({
      name: 't',
      kind: 'telegram',
      token: '9:X',
      chatId: '5',
      url: undefined,
    });
  });

  it('leaves channels with a token, and other kinds, alone', () => {
    const withToken = { name: 't', kind: 'telegram' as const, token: '9:X', chatId: '5' };
    expect(channelForEditing(withToken)).toEqual(withToken);
    const slack = { name: 's', kind: 'slack' as const, url: 'https://hooks.slack.com/x' };
    expect(channelForEditing(slack)).toEqual(slack);
  });
});

describe('channelForSaving', () => {
  it('keeps only the fields the kind uses', () => {
    expect(channelForSaving({ name: ' t ', kind: 'telegram', token: ' 9:X ', chatId: ' 5 ', url: 'https://old/x' })).toEqual({ name: 't', kind: 'telegram', token: '9:X', chatId: '5' });
    expect(channelForSaving({ name: 't', kind: 'telegram', chatId: '', url: 'https://api.telegram.org/bot9:X/sendMessage' })).toEqual({ name: 't', kind: 'telegram', url: 'https://api.telegram.org/bot9:X/sendMessage' });
    expect(channelForSaving({ name: 'd', kind: 'discord', url: ' https://d/x ', token: 'ignored' })).toEqual({ name: 'd', kind: 'discord', url: 'https://d/x' });
    expect(channelForSaving({ name: 'c', kind: 'command', command: { command: 'notify-send {text}' } })).toEqual({ name: 'c', kind: 'command', command: { command: 'notify-send {text}', shell: undefined } });
  });
});

describe('channelSummary', () => {
  it('names the bot without showing its secret', () => {
    expect(channelSummary({ name: 't', kind: 'telegram', token: '123456:SECRET', chatId: '-1001' })).toBe('telegram · bot 123456 → -1001');
    expect(channelSummary({ name: 't', kind: 'telegram', url: 'https://api.telegram.org/botSECRET/sendMessage' })).toBe('telegram · https://api.telegram.org/bot…/sendMessage');
    expect(channelSummary({ name: 'c', kind: 'command', command: { command: 'notify-send {text}' } })).toBe('command · notify-send {text}');
  });
});
