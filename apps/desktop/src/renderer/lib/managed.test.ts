import { describe, expect, it } from 'vitest';
import { isManaged, managedChildren } from './managed';

describe('isManaged', () => {
  const managed = ['autonomy', 'maxInputLockMs', 'permissions.moduleAllow.system', 'web.allowlist'];
  it('matches exact paths and parents', () => {
    expect(isManaged(managed, 'maxInputLockMs')).toBe(true);
    expect(isManaged(managed, 'autonomy')).toBe(true);
    expect(isManaged(managed, 'autonomy.maxSelfWakesPerHour')).toBe(true);
    expect(isManaged(managed, 'permissions.moduleAllow.system')).toBe(true);
    expect(isManaged(managed, 'web.allowlist')).toBe(true);
  });
  it('does not match children of a managed leaf, siblings, or prefixes without a dot', () => {
    expect(isManaged(managed, 'permissions.moduleAllow')).toBe(false);
    expect(isManaged(managed, 'permissions.moduleAllow.media')).toBe(false);
    expect(isManaged(managed, 'autonomyExtra')).toBe(false);
    expect(isManaged(managed, 'web.maxBytes')).toBe(false);
    expect(isManaged(managed, '')).toBe(false);
    expect(isManaged(undefined, 'autonomy')).toBe(false);
    expect(isManaged([], 'autonomy')).toBe(false);
  });
  it('managedChildren lists forced entries under a path', () => {
    expect(managedChildren(managed, 'permissions.moduleAllow')).toEqual(['system']);
    expect(managedChildren(managed, 'autonomy')).toEqual([]);
    expect(managedChildren(managed, 'senses')).toEqual([]);
  });
});
