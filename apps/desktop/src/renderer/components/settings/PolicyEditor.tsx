import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { PolicyFile, SystemIntegrationStatus } from '@rp/shared';
import { GUARD_SHELLS, functionKey, isAlwaysAvailableModule, parseFunctionKey } from '@rp/shared';
import { api, errorMessage } from '../../api';
import { prettyJson } from '../../lib/format';
import type { PackSource } from '@rp/shared';
import type { PolicyDraft, PolicySettingSpec, PolicyValue } from '../../lib/policy';
import {
  POLICY_DEV,
  POLICY_EMERGENCY_KEYS,
  POLICY_GROUPS,
  POLICY_RESTRICTIONS,
  POLICY_SETTINGS,
  guardPathProblem,
  packSourceProblem,
  policyDraftFrom,
  policyDraftProblems,
  policyDraftToFile,
  policyEffects,
  policyRefusals,
  toggleShell,
  userNameProblem,
} from '../../lib/policy';
import { useAppState } from '../../store/store';
import { toast } from '../../store/actions';
import { Modal } from '../common/Modal';
import { StringListEditor } from '../common/StringListEditor';
import { Toggle } from '../common/Toggle';
import { CodeDialog } from './SealSection';

type TabId = 'app' | 'guard' | 'lock' | 'settings' | 'remote' | 'review';

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'app', label: 'The app' },
  { id: 'settings', label: 'Forced settings' },
  { id: 'remote', label: 'Remote & packs' },
  { id: 'guard', label: 'Session guard' },
  { id: 'lock', label: 'Input lock' },
  { id: 'review', label: 'Review' },
];

const GUARD_MODE_HINTS: Record<string, string> = {
  off: 'Nothing is confined. The profiles are unloaded if they were on.',
  audit: 'Everything is allowed, and every attempt is logged to the audit log below. Start here to see what would break.',
  enforce: 'Attempts are blocked. The listed users’ own terminals and scripts can no longer reach the compositor or shell.',
};

const COMPOSITOR_HINTS: Record<string, string> = {
  allow: 'Anything in the session may drive the compositor.',
  'shell-only': 'Only the shell and rpchat may; the user’s terminals and scripts may not.',
  deny: 'Nothing in the session may, not even the shell.',
};

/** A small radio group that reads as one control — modes, keys and backends rather than a dropdown. */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  label,
}: {
  value: T;
  options: readonly T[] | ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  label: string;
}) {
  const items = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {items.map((o) => (
        <button key={o.value} type="button" role="radio" className="seg-btn" aria-checked={value === o.value} disabled={disabled} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A labelled switch with its explanation, as used down the App, Guard and Input lock tabs. */
function SwitchRow({ label, hint, checked, onChange, disabled }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="policy-row">
      <Toggle checked={checked} onChange={onChange} disabled={disabled} aria-label={label} />
      <span className="policy-row-label">
        <span>{label}</span>
        <span className="policy-row-hint">{hint}</span>
      </span>
    </div>
  );
}

/** A duration edited in seconds; the policy carries milliseconds. */
function DurationInput({ ms, onChange, disabled, label, min }: { ms: number; onChange: (ms: number) => void; disabled?: boolean; label: string; min?: number }) {
  return (
    <span className="row" style={{ gap: 6 }}>
      <input
        type="number"
        step="any"
        min={min === undefined ? undefined : min / 1000}
        style={{ width: 96 }}
        value={Number.isFinite(ms) ? ms / 1000 : ''}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(Math.round(Number(e.target.value) * 1000))}
      />
      <span className="muted small nowrap">s</span>
    </span>
  );
}

type PinState = 'free' | 'allow' | 'deny';

function pinOf(value: Record<string, boolean>, key: string): PinState {
  return value[key] === undefined ? 'free' : value[key] ? 'allow' : 'deny';
}

const PIN_OPTIONS = [
  { value: 'free' as const, label: 'user’s choice' },
  { value: 'allow' as const, label: 'allow' },
  { value: 'deny' as const, label: 'deny' },
];

/**
 * `permissions.functionAllow`: a key named here is pinned allowed or denied for everyone, and one
 * left out stays the user's own choice — so each row is a three-way, not a checkbox. A module row
 * pins the module as a whole; expanding it pins single functions, which win over the module's own
 * pin. `sdk.lib` is the character's own library and is never pinnable.
 */
function FunctionAllowEditor({ value, onChange, disabled }: { value: Record<string, boolean>; onChange: (v: Record<string, boolean>) => void; disabled?: boolean }) {
  const caps = useAppState((s) => s.capabilities);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const known = caps.filter((c) => !isAlwaysAvailableModule(c.id));
  const extra = [...new Set(Object.keys(value).map((k) => parseFunctionKey(k).module))].filter((id) => !known.some((c) => c.id === id));
  const rows = [
    ...known.map((c) => ({ id: c.id, title: c.title, summary: c.summary, methods: c.methods.map((m) => m.name) })),
    ...extra.map((id) => ({ id, title: id, summary: 'Not reported by this build.', methods: [] as string[] })),
  ];
  const set = (key: string, state: PinState) => {
    const next = { ...value };
    if (state === 'free') delete next[key];
    else next[key] = state === 'allow';
    onChange(next);
  };
  if (rows.length === 0) return <span className="muted small">No capability modules reported.</span>;
  return (
    <div className="stack" style={{ gap: 4 }}>
      {rows.map((r) => {
        const pinnedFunctions = r.methods.filter((m) => value[functionKey(r.id, m)] !== undefined).length;
        return (
          <div key={r.id} className="stack" style={{ gap: 2 }}>
            <div className="row list-row">
              <span className="grow item-text">
                <span className="item-title">
                  {r.title} <span className="muted mono small">sdk.{r.id}</span>
                  {pinnedFunctions > 0 ? (
                    <span className="badge" style={{ marginLeft: 6 }}>
                      {pinnedFunctions} function{pinnedFunctions === 1 ? '' : 's'} pinned
                    </span>
                  ) : null}
                </span>
                <span className="item-sub">{r.summary}</span>
              </span>
              {r.methods.length > 0 ? (
                <button type="button" className="ghost small" aria-expanded={open[r.id] === true} onClick={() => setOpen((o) => ({ ...o, [r.id]: !o[r.id] }))}>
                  {open[r.id] ? 'Hide functions' : `${r.methods.length} functions`}
                </button>
              ) : null}
              <Segmented label={`${r.title} policy`} value={pinOf(value, r.id)} disabled={disabled} options={PIN_OPTIONS} onChange={(v) => set(r.id, v)} />
            </div>
            {open[r.id]
              ? r.methods.map((m) => (
                  <div key={m} className="row list-row" style={{ paddingLeft: 24 }}>
                    <span className="grow item-text">
                      <span className="item-title mono small">
                        sdk.{r.id}.{m}
                      </span>
                    </span>
                    <Segmented label={`sdk.${r.id}.${m} policy`} value={pinOf(value, functionKey(r.id, m))} disabled={disabled} options={PIN_OPTIONS} onChange={(v) => set(functionKey(r.id, m), v)} />
                  </div>
                ))
              : null}
          </div>
        );
      })}
    </div>
  );
}

/** One forcible settings key: the switch that decides whether it is written, and the value it is written with. */
function SettingRow({ spec, draft, onDraft, disabled }: { spec: PolicySettingSpec; draft: PolicyDraft; onDraft: (next: PolicyDraft) => void; disabled?: boolean }) {
  const on = draft.forced[spec.path] === true;
  const value = draft.values[spec.path];
  const setForced = (forced: boolean) => onDraft({ ...draft, forced: { ...draft.forced, [spec.path]: forced } });
  const setValue = (next: PolicyValue) => onDraft({ ...draft, values: { ...draft.values, [spec.path]: next } });
  const wide = spec.kind === 'list' || spec.kind === 'functions';

  let control: ReactNode = null;
  if (spec.kind === 'boolean') control = <Toggle checked={value === true} disabled={!on || disabled} onChange={setValue} aria-label={spec.label} />;
  else if (spec.kind === 'number') {
    control = (
      <input
        type="number"
        min={spec.min}
        style={{ width: 96 }}
        value={typeof value === 'number' ? value : ''}
        disabled={!on || disabled}
        aria-label={spec.label}
        onChange={(e) => setValue(Math.round(Number(e.target.value)))}
      />
    );
  } else if (spec.kind === 'duration') control = <DurationInput ms={typeof value === 'number' ? value : 0} min={spec.min} disabled={!on || disabled} label={spec.label} onChange={setValue} />;
  else if (spec.kind === 'choice') control = <Segmented label={spec.label} value={String(value)} options={spec.choices ?? []} disabled={!on || disabled} onChange={setValue} />;
  else if (spec.kind === 'list') {
    control = (
      <StringListEditor
        id={`policy-${spec.path}`}
        values={Array.isArray(value) ? value : []}
        placeholder={spec.placeholder}
        disabled={!on || disabled}
        emptyLabel="Empty — the policy allows nothing here."
        onChange={setValue}
      />
    );
  } else if (spec.kind === 'functions') control = <FunctionAllowEditor value={(value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, boolean>} disabled={!on || disabled} onChange={setValue} />;

  return (
    <div className={`policy-row${wide ? ' wide' : ''}${on ? '' : ' off'}`}>
      <input type="checkbox" checked={on} disabled={disabled} aria-label={`Force ${spec.label}`} onChange={(e) => setForced(e.target.checked)} />
      <span className="policy-row-label">
        <span>{spec.label}</span>
        <span className="policy-row-hint">{on ? spec.hint : `${spec.hint} Left to each user.`}</span>
      </span>
      <div className="policy-row-control">{control}</div>
    </div>
  );
}

/**
 * Settings → System → "Create policy…": the whole root-owned policy file as a form. The file is
 * write-once, so everything it would refuse is caught here and the exact JSON is shown before it
 * goes to the daemon.
 */
export function CreatePolicyDialog({
  path,
  sealed,
  onClose,
  onCreated,
}: {
  path: string;
  /** The machine is locked behind a code: this writes a *replacement*, which needs one. */
  sealed?: boolean;
  onClose: () => void;
  onCreated: (status: SystemIntegrationStatus) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [codeDialog, setCodeDialog] = useState(false);
  const [tab, setTab] = useState<TabId>('app');
  const [loading, setLoading] = useState(true);
  const [understood, setUnderstood] = useState(false);
  const [writing, setWriting] = useState(false);
  const [refused, setRefused] = useState<string[] | null>(null);
  const [pasted, setPasted] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);

  const reset = useCallback(async () => {
    setLoading(true);
    setRefused(null);
    try {
      setDraft(policyDraftFrom(JSON.parse(await api().system.policyTemplate()) as PolicyFile));
    } catch (err) {
      // Without a template the form still works; it just starts from a policy that forces nothing.
      setDraft(policyDraftFrom({ version: 1 }));
      setRefused([`Could not read your current settings to start from: ${errorMessage(err)}`]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reset();
  }, [reset]);

  const file = useMemo(() => (draft ? policyDraftToFile(draft) : null), [draft]);
  const problems = useMemo(() => (draft ? policyDraftProblems(draft) : []), [draft]);
  const effects = useMemo(() => (draft ? policyEffects(draft) : []), [draft]);
  const forcedCount = draft ? POLICY_SETTINGS.filter((s) => draft.forced[s.path]).length : 0;

  const write = async (code?: string) => {
    if (!file) return;
    setWriting(true);
    setRefused(null);
    try {
      const text = `${prettyJson(file)}\n`;
      await onCreated(code ? await api().system.replacePolicy(text, code) : await api().system.createPolicy(text));
      setCodeDialog(false);
    } catch (err) {
      setRefused(policyRefusals(errorMessage(err)));
    } finally {
      setWriting(false);
    }
  };

  const submit = () => {
    if (sealed) setCodeDialog(true);
    else void write();
  };

  const loadPasted = () => {
    try {
      const parsed = JSON.parse(pasted) as PolicyFile;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the document is not a JSON object');
      setDraft(policyDraftFrom(parsed));
      setPasted('');
      setPasteError(null);
      setTab('app');
      toast('success', 'Loaded into the form');
    } catch (err) {
      setPasteError(errorMessage(err));
    }
  };

  const busy = loading || writing;
  const setAllForced = (forced: boolean) => {
    if (!draft) return;
    setDraft({ ...draft, forced: Object.fromEntries(POLICY_SETTINGS.map((s) => [s.path, forced])) });
  };

  return (
    <Modal title={sealed ? 'Replace the policy file' : 'Create the policy file'} onClose={writing ? undefined : onClose} className="policy-modal">
      <div className="callout callout-warning small">
        {sealed ? (
          <>
            Replaces <code className="nowrap">{path}</code> through the rpchat daemon. This machine is locked, so the code your authenticator app is showing is asked for before
            anything is written, and the lock is re-pinned to whatever you write here.
          </>
        ) : (
          <>
            Writes <code className="nowrap">{path}</code> through the rpchat daemon — no password needed, but <strong>only once</strong>. Afterwards only root can change or remove
            it, and what it says overrides the settings of every user on this machine. Lock it behind an authenticator code afterwards and you can change it again from here.
          </>
        )}
      </div>

      <div className="field">
        <label htmlFor="policy-managed-by">Managed by</label>
        <input
          id="policy-managed-by"
          type="text"
          placeholder="IT, your name, a team — shown to users in Settings → System"
          value={draft?.managedBy ?? ''}
          disabled={busy || !draft}
          onChange={(e) => draft && setDraft({ ...draft, managedBy: e.target.value })}
        />
      </div>

      <div className="tabs" role="tablist" aria-label="Policy sections">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" className="tab" aria-selected={tab === t.id} disabled={!draft} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === 'settings' && draft ? <span className="chip-count" style={{ marginLeft: 5 }}>{forcedCount}</span> : null}
          </button>
        ))}
      </div>

      <div className="policy-body">
        {!draft ? (
          <div className="row muted small">
            <span className="spinner" /> Reading your current settings…
          </div>
        ) : null}

        {draft && tab === 'app' ? (
          <div className="stack" style={{ gap: 14 }}>
            <section className="stack" style={{ gap: 6 }}>
              <h3 style={{ margin: 0 }}>Quitting</h3>
              <SwitchRow
                label="Users may quit the app"
                hint="Off removes every way to quit from the UI, and the daemon starts it again if the process dies anyway."
                checked={draft.app.allowQuit}
                disabled={busy}
                onChange={(v) => setDraft({ ...draft, app: { ...draft.app, allowQuit: v } })}
              />
              <div className="field">
                <label htmlFor="policy-users">Unix users this applies to</label>
                <span className="field-hint">
                  The daemon relaunches the app for these users, and the session guard confines their login sessions. Nobody else is affected.
                </span>
                <StringListEditor
                  id="policy-users"
                  values={draft.app.users}
                  placeholder="alice"
                  disabled={busy}
                  validate={userNameProblem}
                  emptyLabel="Nobody listed — the app is not relaunched and the guard has nobody to confine."
                  onChange={(users) => setDraft({ ...draft, app: { ...draft.app, users } })}
                />
              </div>
              {!draft.app.allowQuit && draft.app.users.length === 0 ? (
                <div className="callout callout-warning small">Quitting is disabled but no user is listed, so a killed app stays down. Add the users whose sessions run it.</div>
              ) : null}
            </section>

            <section className="stack" style={{ gap: 6 }}>
              <h3 style={{ margin: 0 }}>What the app may do</h3>
              <p className="field-hint" style={{ margin: 0 }}>
                On means allowed, as it is without a policy. Switching one off refuses the matching calls everywhere — the UI hides the action rather
                than failing at it.
              </p>
              <div className="stack" style={{ gap: 2 }}>
                {POLICY_RESTRICTIONS.map(({ key, label, hint }) => (
                  <SwitchRow
                    key={key}
                    label={label}
                    hint={hint}
                    checked={draft.app.restrictions[key]}
                    disabled={busy}
                    onChange={(v) => setDraft({ ...draft, app: { ...draft.app, restrictions: { ...draft.app.restrictions, [key]: v } } })}
                  />
                ))}
              </div>
            </section>

            <section className="stack" style={{ gap: 6 }}>
              <h3 style={{ margin: 0 }}>Development</h3>
              <p className="field-hint" style={{ margin: 0 }}>
                The switches the app carries for its own development. They are read once, when the app starts, straight from this file — not through
                any path an environment variable names — so nothing a user launches the app with can turn them back on.
              </p>
              <div className="stack" style={{ gap: 2 }}>
                {POLICY_DEV.map(({ key, label, hint }) => (
                  <SwitchRow
                    key={key}
                    label={label}
                    hint={hint}
                    checked={draft.dev[key]}
                    disabled={busy}
                    onChange={(v) => setDraft({ ...draft, dev: { ...draft.dev, [key]: v, ...(key === 'allow' && !v ? { devTools: false } : {}) } })}
                  />
                ))}
              </div>
              {!draft.dev.allow && draft.dev.devTools ? (
                <div className="callout callout-warning small">
                  DevTools stay open on a machine whose development switches are off. The inspector can reach anything the interface can, so leave it
                  on only while you need it for support.
                </div>
              ) : null}
            </section>
          </div>
        ) : null}

        {draft && tab === 'settings' ? (
          <div className="stack" style={{ gap: 14 }}>
            <div className="row">
              <p className="field-hint grow" style={{ margin: 0 }}>
                A key you switch on is pinned for every user on this machine and shown to them as <em>managed by policy</em>. A key left off stays
                theirs to change. {forcedCount} of {POLICY_SETTINGS.length} on.
              </p>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setAllForced(true)}>
                Force all
              </button>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setAllForced(false)}>
                Force none
              </button>
            </div>
            {POLICY_GROUPS.map((group) => (
              <section key={group.id} className="stack" style={{ gap: 4 }}>
                <h3 style={{ margin: 0 }}>{group.title}</h3>
                <p className="field-hint" style={{ margin: '0 0 2px' }}>
                  {group.hint}
                </p>
                {POLICY_SETTINGS.filter((s) => s.group === group.id).map((spec) => (
                  <SettingRow key={spec.path} spec={spec} draft={draft} disabled={busy} onDraft={setDraft} />
                ))}
              </section>
            ))}
          </div>
        ) : null}

        {draft && tab === 'guard' ? (
          <div className="stack" style={{ gap: 14 }}>
            <p className="field-hint" style={{ margin: 0 }}>
              AppArmor confinement of the listed users’ login sessions, so their own terminals, keybind scripts and pickers cannot reach the
              compositor’s and shell’s sockets, rewrite the wallpaper and shell config, or signal rpchat — while rpchat itself still may.
            </p>
            <div className="field">
              <span className="field-label">Mode</span>
              <Segmented label="Guard mode" value={draft.guard.mode} options={['off', 'audit', 'enforce'] as const} disabled={busy} onChange={(mode) => setDraft({ ...draft, guard: { ...draft.guard, mode } })} />
              <span className="field-hint">{GUARD_MODE_HINTS[draft.guard.mode]}</span>
            </div>
            {draft.guard.mode !== 'off' && draft.app.users.length === 0 ? (
              <div className="callout callout-danger small">The guard confines the users listed on the <strong>The app</strong> tab, and none are listed. The daemon refuses a policy like this.</div>
            ) : null}
            <div className="stack" style={{ gap: 2 }}>
              <SwitchRow label="Protect rpchat" hint="Signals and ptrace from the session to rpchat are refused, so the session cannot kill or attach to it." checked={draft.guard.protectApp} disabled={busy} onChange={(v) => setDraft({ ...draft, guard: { ...draft.guard, protectApp: v } })} />
              <SwitchRow label="Protect the wallpaper and shell" hint="The shell’s IPC socket and its config and state files are guarded from the session." checked={draft.guard.wallpaper} disabled={busy} onChange={(v) => setDraft({ ...draft, guard: { ...draft.guard, wallpaper: v } })} />
            </div>
            <div className="field">
              <span className="field-label">Who may drive the compositor</span>
              <Segmented label="Compositor IPC" value={draft.guard.compositorIpc} options={['allow', 'shell-only', 'deny'] as const} disabled={busy} onChange={(compositorIpc) => setDraft({ ...draft, guard: { ...draft.guard, compositorIpc } })} />
              <span className="field-hint">{COMPOSITOR_HINTS[draft.guard.compositorIpc]}</span>
            </div>
            <div className="field">
              <span className="field-label">Shell</span>
              <span className="field-hint">
                Which shell the rules are written for. <code>auto</code> picks the first whose binary is installed; pick several when a bar and a
                wallpaper daemon both run.
              </span>
              <div className="chips" style={{ marginTop: 4 }}>
                {GUARD_SHELLS.map((shell) => {
                  const on = draft.guard.shell.includes(shell);
                  return (
                    <button
                      key={shell}
                      type="button"
                      className={on ? 'chip-btn on' : 'chip-btn'}
                      aria-pressed={on}
                      disabled={busy}
                      onClick={() => setDraft({ ...draft, guard: { ...draft.guard, shell: toggleShell(draft.guard.shell, shell) } })}
                    >
                      {shell}
                    </button>
                  );
                })}
              </div>
            </div>
            <details>
              <summary className="small">Extra rules</summary>
              <div className="stack" style={{ gap: 12, marginTop: 8 }}>
                <GuardPaths
                  id="policy-login-helpers"
                  label="Login helpers"
                  hint="PAM helpers that carry the per-user hats. Leave empty to let the daemon detect the ones on this machine."
                  values={draft.guard.loginHelpers}
                  allowHome={false}
                  disabled={busy}
                  placeholder="/usr/bin/greetd"
                  emptyLabel="Empty — detected automatically."
                  onChange={(loginHelpers) => setDraft({ ...draft, guard: { ...draft.guard, loginHelpers } })}
                />
                <GuardPaths id="policy-deny-paths" label="More files the session may not write" hint="Absolute, or under the home directory with ~/ or @{HOME}/. Globs allowed." values={draft.guard.extraDenyPaths} allowHome disabled={busy} placeholder="~/.config/hypr/hyprpaper.conf" onChange={(extraDenyPaths) => setDraft({ ...draft, guard: { ...draft.guard, extraDenyPaths } })} />
                <GuardPaths id="policy-deny-sockets" label="More sockets the session may not connect to" hint="Unix socket paths." values={draft.guard.extraDenySockets} allowHome disabled={busy} placeholder="/run/user/1000/some.sock" onChange={(extraDenySockets) => setDraft({ ...draft, guard: { ...draft.guard, extraDenySockets } })} />
                <GuardPaths id="policy-allow-binaries" label="Binaries that run unconfined" hint="Executables that leave the confinement entirely. Each one is a hole in the guard." values={draft.guard.allowBinaries} allowHome={false} disabled={busy} placeholder="/usr/bin/systemctl" onChange={(allowBinaries) => setDraft({ ...draft, guard: { ...draft.guard, allowBinaries } })} />
              </div>
            </details>
          </div>
        ) : null}

        {draft && tab === 'remote' ? (
          <div className="stack" style={{ gap: 12 }}>
            <p className="field-hint" style={{ margin: 0 }}>
              Where this machine's policy chain is published, and which packs it is meant to have. The key that signs the chain is not set here — it is pinned by the Remote Link, so
              that a policy cannot name the key that authorises it. A signed link may move the address and the schedule below.
            </p>
            <SwitchRow
              label="Fetch the policy from a URL"
              hint="Off keeps this machine's policy local. On, the app re-reads the address on the interval and hands what it finds to the daemon."
              checked={draft.remote.enabled}
              disabled={busy}
              onChange={(enabled) => setDraft({ ...draft, remote: { ...draft.remote, enabled } })}
            />
            {draft.remote.enabled ? (
              <>
                <div className="field">
                  <label htmlFor="policy-remote-url">Address</label>
                  <input
                    id="policy-remote-url"
                    type="text"
                    placeholder="https://example.com/rpchat/policy.json"
                    value={draft.remote.url}
                    disabled={busy}
                    onChange={(e) => setDraft({ ...draft, remote: { ...draft.remote, url: e.target.value } })}
                  />
                  <span className="field-hint">https:// anywhere, or http:// on 127.0.0.1 for an agent running on this machine.</span>
                </div>
                <div className="field">
                  <label htmlFor="policy-remote-interval">Check every</label>
                  <div className="row" style={{ gap: 6 }}>
                    <input
                      id="policy-remote-interval"
                      type="number"
                      min={5}
                      max={1440}
                      value={draft.remote.intervalMinutes}
                      disabled={busy}
                      style={{ width: 90 }}
                      onChange={(e) => setDraft({ ...draft, remote: { ...draft.remote, intervalMinutes: Number(e.target.value) } })}
                    />
                    <span className="muted small">minutes (5 to 1440)</span>
                  </div>
                </div>
              </>
            ) : null}

            <hr className="rule" />
            <PackSources sources={draft.packs.sources} disabled={busy} onChange={(sources) => setDraft({ ...draft, packs: { ...draft.packs, sources } })} />
            <SwitchRow
              label="Remove packs that are not listed"
              hint="The machine ends up with exactly the packs above. Anything a user installed themselves is uninstalled on the next check."
              checked={draft.packs.removeUnlisted}
              disabled={busy}
              onChange={(removeUnlisted) => setDraft({ ...draft, packs: { ...draft.packs, removeUnlisted } })}
            />
          </div>
        ) : null}

        {draft && tab === 'lock' ? (
          <div className="stack" style={{ gap: 12 }}>
            <p className="field-hint" style={{ margin: 0 }}>
              Hard limits the daemon enforces on <code>sdk.input.lock</code>, whatever the app or its settings ask for. The app-side cap lives on the{' '}
              <strong>Forced settings</strong> tab; this one is the floor under it.
            </p>
            <SwitchRow label="Input locking allowed at all" hint="Off refuses every lock outright, so no character can take the keyboard or mouse." checked={draft.inputLock.enabled} disabled={busy} onChange={(enabled) => setDraft({ ...draft, inputLock: { ...draft.inputLock, enabled } })} />
            <div className="field">
              <label htmlFor="policy-lock-max">Longest single lock</label>
              <DurationInput ms={draft.inputLock.maxDurationMs} min={1000} disabled={busy || !draft.inputLock.enabled} label="Longest single lock" onChange={(maxDurationMs) => setDraft({ ...draft, inputLock: { ...draft.inputLock, maxDurationMs } })} />
              <span className="field-hint">At least 1 s. The lock ends on its own after this however the app behaves.</span>
            </div>
            <div className="field">
              <span className="field-label">Emergency unlock</span>
              <span className="field-hint">Holding this key for the given time forces an unlock, so a user is never stuck.</span>
              <div className="row" style={{ gap: 8, marginTop: 4 }}>
                <Segmented label="Emergency key" value={draft.inputLock.emergencyKey} options={POLICY_EMERGENCY_KEYS} disabled={busy || !draft.inputLock.enabled} onChange={(emergencyKey) => setDraft({ ...draft, inputLock: { ...draft.inputLock, emergencyKey } })} />
                <span className="muted small">held for</span>
                <DurationInput ms={draft.inputLock.emergencyHoldMs} min={500} disabled={busy || !draft.inputLock.enabled} label="Emergency hold" onChange={(emergencyHoldMs) => setDraft({ ...draft, inputLock: { ...draft.inputLock, emergencyHoldMs } })} />
              </div>
            </div>

            <hr className="rule" />
            <p className="field-hint" style={{ margin: 0 }}>
              <strong>The policy lock.</strong> These decide how hard the policy holds once you lock it behind an authenticator code (Settings → System → <em>Lock policy</em>).
              Locking adds this block by itself if you leave it off, so it is here to change the defaults, not to turn the lock on.
            </p>
            <SwitchRow
              label="Write the lock settings into the file"
              hint="Off leaves the block out and the defaults below apply anyway. On writes them, so anyone reading the policy can see what is in force."
              checked={draft.lock.enabled}
              disabled={busy}
              onChange={(enabled) => setDraft({ ...draft, lock: { ...draft.lock, enabled } })}
            />
            {draft.lock.enabled ? (
              <>
                <div className="row" style={{ gap: 12 }}>
                  <div className="field">
                    <label htmlFor="policy-lock-digits">Code length</label>
                    <input id="policy-lock-digits" type="number" min={6} max={8} style={{ width: 80 }} value={draft.lock.digits} disabled={busy} onChange={(e) => setDraft({ ...draft, lock: { ...draft.lock, digits: Number(e.target.value) } })} />
                  </div>
                  <div className="field">
                    <label htmlFor="policy-lock-period">Code lasts</label>
                    <div className="row" style={{ gap: 6 }}>
                      <input id="policy-lock-period" type="number" min={15} max={300} style={{ width: 80 }} value={draft.lock.period} disabled={busy} onChange={(e) => setDraft({ ...draft, lock: { ...draft.lock, period: Number(e.target.value) } })} />
                      <span className="muted small">seconds</span>
                    </div>
                  </div>
                </div>
                <SwitchRow label="Put the policy back when it is edited" hint="The daemon compares the file against the locked copy every few seconds and rewrites it, logging the attempt." checked={draft.lock.selfHeal} disabled={busy} onChange={(selfHeal) => setDraft({ ...draft, lock: { ...draft.lock, selfHeal } })} />
                <SwitchRow label="Mark the files immutable" hint="Sets the immutable attribute, so a plain delete or editor save fails until someone runs chattr -i first." checked={draft.lock.immutable} disabled={busy} onChange={(immutable) => setDraft({ ...draft, lock: { ...draft.lock, immutable } })} />
                <SwitchRow label="Refuse a manual stop of the service" hint="Writes a systemd drop-in with RefuseManualStop, so `systemctl stop rpchatd` is declined." checked={draft.lock.refuseManualStop} disabled={busy} onChange={(refuseManualStop) => setDraft({ ...draft, lock: { ...draft.lock, refuseManualStop } })} />
                <SwitchRow
                  label="Take away the ways out of the session guard"
                  hint="With the guard in enforce mode, the confined users lose run0, systemd-run, machinectl, pkexec, chattr and apparmor_parser — the commands that would start a shell outside the confinement or undo the lock. sudo stays: its children stay confined."
                  checked={draft.lock.denyEscapes}
                  disabled={busy}
                  onChange={(denyEscapes) => setDraft({ ...draft, lock: { ...draft.lock, denyEscapes } })}
                />
              </>
            ) : null}
          </div>
        ) : null}

        {draft && tab === 'review' && file ? (
          <div className="stack" style={{ gap: 10 }}>
            <div className="row">
              <p className="field-hint grow" style={{ margin: 0 }}>
                Exactly what is written to <code className="nowrap">{path}</code>. Keys you left to the user are simply absent.
              </p>
              <button type="button" className="btn btn-sm" onClick={() => void copy(prettyJson(file))}>
                Copy
              </button>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={reset}>
                Start over
              </button>
            </div>
            <pre className="code policy-json">{prettyJson(file)}</pre>
            <details>
              <summary className="small">Load a policy from JSON</summary>
              <div className="stack" style={{ gap: 6, marginTop: 8 }}>
                <p className="field-hint" style={{ margin: 0 }}>
                  Paste a policy you prepared elsewhere to fill the form in from it. Keys this app does not understand are dropped.
                </p>
                <textarea className="code" rows={8} spellCheck={false} value={pasted} disabled={busy} aria-label="Policy JSON to load" onChange={(e) => setPasted(e.target.value)} />
                {pasteError ? <span className="field-hint msg-error">{pasteError}</span> : null}
                <div>
                  <button type="button" className="btn btn-sm" disabled={busy || pasted.trim().length === 0} onClick={loadPasted}>
                    Load into the form
                  </button>
                </div>
              </div>
            </details>
          </div>
        ) : null}
      </div>

      <div className="policy-summary">
        <span className="muted small">This policy:</span>
        {effects.map((e) => (
          <span key={e.text} className={e.strict ? 'badge badge-warning' : 'badge'}>
            {e.text}
          </span>
        ))}
        {draft && draft.inputLock.enabled ? <span className="badge">locks up to {briefDuration(draft.inputLock.maxDurationMs)}</span> : null}
      </div>

      {problems.length > 0 ? (
        <div className="callout callout-warning small">
          <strong>Fix these before writing:</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {refused ? (
        <div className="callout callout-danger small">
          <strong>The policy was not written.</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {refused.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <label className="check">
        <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} disabled={writing} />
        {sealed ? 'I understand this replaces what this machine enforces' : 'I understand this cannot be undone without root'}
      </label>
      <div className="form-actions">
        <button type="button" className="btn" onClick={onClose} disabled={writing}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={submit} disabled={!understood || busy || !draft || problems.length > 0}>
          {writing ? 'Writing…' : sealed ? 'Replace policy…' : 'Write policy'}
        </button>
      </div>
      {codeDialog ? <CodeDialog title="Replace the policy" what="replace" busy={writing} onClose={() => setCodeDialog(false)} onSubmit={(code) => void write(code)} /> : null}
    </Modal>
  );
}

/** The pinned packs: an id, where to download it, and optionally a checksum and a version. */
function PackSources({ sources, disabled, onChange }: { sources: PackSource[]; disabled?: boolean; onChange: (sources: PackSource[]) => void }) {
  const [id, setId] = useState('');
  const [url, setUrl] = useState('');
  const [sha256, setSha256] = useState('');
  const [version, setVersion] = useState('');
  const candidate: PackSource = { id: id.trim(), url: url.trim(), ...(sha256.trim() ? { sha256: sha256.trim() } : {}), ...(version.trim() ? { version: version.trim() } : {}) };
  const problem = id.trim() || url.trim() ? packSourceProblem(candidate) : null;
  const add = () => {
    if (problem || !candidate.id || !candidate.url) return;
    onChange([...sources, candidate]);
    setId('');
    setUrl('');
    setSha256('');
    setVersion('');
  };
  return (
    <div className="field">
      <span className="field-label">Packs this machine gets</span>
      <span className="field-hint">
        Each one is downloaded and installed without the user choosing a file. A checksum is optional but strongly recommended: without it the machine installs whatever the address
        serves that day.
      </span>
      {sources.length === 0 ? <p className="muted small">None — users install their own packs.</p> : null}
      <ul className="stack small" style={{ gap: 4, marginTop: 6 }}>
        {sources.map((s, i) => (
          <li key={`${s.id}-${i}`} className="row" style={{ gap: 8 }}>
            <span className="grow">
              <span className="mono">{s.id}</span>
              {s.version ? <span className="muted"> {s.version}</span> : null} <span className="muted">— {s.url}</span>
              {s.sha256 ? <span className="muted"> (checksum pinned)</span> : <span className="msg-warning"> (no checksum)</span>}
            </span>
            <button type="button" className="btn btn-sm btn-ghost" disabled={disabled} onClick={() => onChange(sources.filter((_, n) => n !== i))}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
        <input type="text" placeholder="pack id" aria-label="Pack id" value={id} disabled={disabled} style={{ width: 130 }} onChange={(e) => setId(e.target.value)} />
        <input type="text" placeholder="https://example.com/luna.rppack" aria-label="Pack address" value={url} disabled={disabled} style={{ minWidth: 260, flex: 1 }} onChange={(e) => setUrl(e.target.value)} />
        <input type="text" placeholder="version (optional)" aria-label="Pack version" value={version} disabled={disabled} style={{ width: 130 }} onChange={(e) => setVersion(e.target.value)} />
        <input type="text" placeholder="sha256 (optional)" aria-label="Pack checksum" value={sha256} disabled={disabled} style={{ width: 170 }} onChange={(e) => setSha256(e.target.value)} />
        <button type="button" className="btn btn-sm" disabled={disabled || !candidate.id || !candidate.url || problem !== null} onClick={add}>
          Add
        </button>
      </div>
      {problem ? <span className="field-hint msg-error">{problem}</span> : null}
    </div>
  );
}

/** One of the guard's path lists, refusing an entry AppArmor could not carry as you type it. */
function GuardPaths({
  id,
  label,
  hint,
  values,
  allowHome,
  disabled,
  placeholder,
  emptyLabel,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  values: string[];
  allowHome: boolean;
  disabled?: boolean;
  placeholder: string;
  emptyLabel?: string;
  onChange: (values: string[]) => void;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <span className="field-hint">{hint}</span>
      <StringListEditor id={id} values={values} placeholder={placeholder} disabled={disabled} emptyLabel={emptyLabel} validate={(v) => guardPathProblem(v, allowHome)} onChange={onChange} />
    </div>
  );
}

/** A round duration as a person would say it: "5 min", "30 s". */
function briefDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${Math.round(ms / 100) / 10} s`;
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('success', 'Policy copied');
  } catch {
    toast('error', 'Could not copy');
  }
}
