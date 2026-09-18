import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SandboxRunRequest, SandboxRunResult } from '@rp/shared';
import { api, errorMessage } from '../api';
import { CodeEditor } from '../components/common/CodeEditor';
import { compactJson, formatDuration, prettyJson } from '../lib/format';
import { newId } from '../lib/ids';
import { DEFAULT_SNIPPET, errorLocation, lineCount, loadInput, loadLastCharacter, loadSnippet, parseInputJson, saveInput, saveLastCharacter, saveSnippet } from '../lib/sandbox';
import { openSession, toast } from '../store/actions';
import { useAppState } from '../store/store';

interface SandboxDoc {
  ref: string;
  code: string;
  input: string;
}

type Phase = { kind: 'idle' } | { kind: 'running'; runId: string; startedAt: number } | { kind: 'done'; outcome: SandboxRunResult; startedAt: number } | { kind: 'failed'; message: string };

const SAVE_DELAY_MS = 300;

/**
 * The Sandbox tab: type a script, run it as one of the installed characters, read what came back.
 * The script goes through `sandbox.run`, i.e. `BehaviourRunner.runScript` — the same path as a
 * character's actions, timers and event handlers.
 */
export function SandboxView() {
  const characters = useAppState((s) => s.characters);
  const [characterRef, setCharacterRef] = useState<string>(() => loadLastCharacter() ?? '');
  /** The script and input being edited, tied to the character they belong to (so a switch never saves one character's code under another's key). */
  const [doc, setDoc] = useState<SandboxDoc | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const character = useMemo(() => characters.find((c) => c.ref === characterRef), [characters, characterRef]);
  const code = doc?.code ?? '';
  const inputText = doc?.input ?? '';
  const setCode = (next: string) => setDoc((d) => (d ? { ...d, code: next } : d));
  const setInputText = (next: string) => setDoc((d) => (d ? { ...d, input: next } : d));

  // Keep the selection on an installed character.
  useEffect(() => {
    if (characters.length === 0) return;
    if (!characters.some((c) => c.ref === characterRef)) setCharacterRef(characters[0]!.ref);
  }, [characters, characterRef]);

  // Switching characters loads that character's remembered snippet and input.
  useEffect(() => {
    if (!character || doc?.ref === character.ref) return;
    setDoc({ ref: character.ref, code: loadSnippet(character.ref), input: loadInput(character.ref) });
    setPhase({ kind: 'idle' });
    saveLastCharacter(character.ref);
  }, [character, doc]);

  // Remember what was typed, a little after the last keystroke.
  useEffect(() => {
    if (!doc) return;
    const { ref, code: text, input } = doc;
    const handle = window.setTimeout(() => {
      saveSnippet(ref, text);
      saveInput(ref, input);
    }, SAVE_DELAY_MS);
    return () => window.clearTimeout(handle);
  }, [doc]);

  const parsedInput = useMemo(() => parseInputJson(inputText), [inputText]);
  const running = phase.kind === 'running';

  const run = useCallback(async () => {
    if (!character || running) return;
    if (!parsedInput.ok) {
      toast('error', `Input is not valid JSON: ${parsedInput.error}`);
      return;
    }
    const runId = newId('run');
    const startedAt = Date.now();
    setPhase({ kind: 'running', runId, startedAt });
    try {
      const request: SandboxRunRequest = {
        packId: character.packId,
        characterId: character.characterId,
        code,
        runId,
      };
      if (parsedInput.value !== undefined) request.input = parsedInput.value;
      const outcome = await api().sandbox.run(request);
      setPhase((current) => (current.kind === 'running' && current.runId !== runId ? current : { kind: 'done', outcome, startedAt }));
    } catch (err) {
      setPhase({ kind: 'failed', message: errorMessage(err) });
    }
  }, [character, running, parsedInput, code]);

  const stop = useCallback(async () => {
    if (phase.kind !== 'running') return;
    try {
      await api().sandbox.cancel(phase.runId);
    } catch (err) {
      toast('error', `Could not stop the script: ${errorMessage(err)}`);
    }
  }, [phase]);

  return (
    <div className="view">
      <div className="view-header">
        <h1>Sandbox</h1>
        <div className="row">
          <label htmlFor="sandbox-character" className="muted small">
            Run as
          </label>
          <select id="sandbox-character" value={characterRef} onChange={(e) => setCharacterRef(e.target.value)} style={{ width: 260 }} disabled={running}>
            {characters.length === 0 ? <option value="">No characters installed</option> : null}
            {characters.map((c) => (
              <option key={c.ref} value={c.ref}>
                {c.name} — {c.packName}
              </option>
            ))}
          </select>
          {running ? (
            <button type="button" className="btn btn-danger btn-sm" onClick={stop}>
              Stop
            </button>
          ) : (
            <button type="button" className="btn btn-primary btn-sm" onClick={run} disabled={!character || !parsedInput.ok} title="Ctrl/Cmd+Enter">
              Run
            </button>
          )}
        </div>
      </div>

      {characters.length === 0 ? (
        <div className="callout callout-warning">Install a pack first (Packs → Install): a script always runs as one of its characters.</div>
      ) : null}

      <p className="muted small sandbox-hint">
        The text below is the <strong>body of an async function</strong>, compiled and run exactly like one of {character ? <strong>{character.name}</strong> : 'the character'}
        's own actions: in scope are <code>sdk</code> (the modules the pack is allowed to use), <code>lib</code> (its function library), <code>input</code> (the JSON
        field below, <code>null</code> when empty) and <code>console</code>; <code>return</code> a JSON value to see it here. It runs in the character's session (created
        if it has none) with the same limits and permission prompts, queued behind a running turn; <code>sdk.chat</code>, memories, state and timers land as if the
        character had done it. <kbd>Tab</kbd> indents, <kbd>Ctrl</kbd>+<kbd>Enter</kbd> runs.
      </p>

      <div className="sandbox-body">
        <div className="sandbox-editor-column">
          <CodeEditor language="typescript" path="sandbox" value={code} onChange={setCode} onSubmit={() => void run()} readOnly={!doc} height="56vh" ariaLabel="Script" />
          <div className="row" style={{ marginTop: 8 }}>
            <span className="muted small grow">
              {lineCount(code)} line{lineCount(code) === 1 ? '' : 's'} · TypeScript
            </span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCode(DEFAULT_SNIPPET)} disabled={running || code === DEFAULT_SNIPPET}>
              Reset to example
            </button>
          </div>
          <div className="field" style={{ marginTop: 12 }}>
            <span className="field-label">
              Input (JSON, optional) — bound as <code>input</code>
            </span>
            <CodeEditor
              language="json"
              path="sandbox-input"
              value={inputText}
              onChange={setInputText}
              onSubmit={() => void run()}
              readOnly={!doc}
              invalid={!parsedInput.ok}
              height={110}
              ariaLabel="Input JSON"
              placeholder='{"greeting": "hi"}'
            />
            {!parsedInput.ok ? <span className="field-hint sandbox-invalid">Not valid JSON: {parsedInput.error}</span> : null}
          </div>
        </div>

        <div className="sandbox-output">
          <OutputPanel phase={phase} />
        </div>
      </div>
    </div>
  );
}

function OutputPanel({ phase }: { phase: Phase }) {
  if (phase.kind === 'idle') {
    return <p className="muted">Nothing has run yet. Press Run or Ctrl+Enter.</p>;
  }
  if (phase.kind === 'running') {
    return (
      <div className="row muted">
        <span className="spinner" /> Running… (waits for a turn in progress, then the limits from Settings apply)
      </div>
    );
  }
  if (phase.kind === 'failed') {
    return (
      <div className="callout callout-danger">
        <strong>Could not run the script</strong> — {phase.message}
      </div>
    );
  }
  const { outcome } = phase;
  const r = outcome.result;
  const location = errorLocation(r.error);
  return (
    <div className="stack sandbox-result">
      <div className="row">
        <span className={r.ok ? 'badge badge-success' : 'badge badge-danger'}>{r.ok ? 'ok' : 'error'}</span>
        <span className="muted small">
          {formatDuration(r.durationMs)} · {r.calls.length} SDK call{r.calls.length === 1 ? '' : 's'} · {r.logs.length} log line{r.logs.length === 1 ? '' : 's'}
        </span>
        <span className="grow" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void openSession(outcome.sessionId)} title="Open the session the script ran in">
          Open chat
        </button>
      </div>

      {r.error ? (
        <div>
          <h4 className="sandbox-h4">Error</h4>
          <div className="callout callout-danger">
            <div>
              <strong>{r.error.code}</strong> — {r.error.message}
              {location.line !== undefined ? (
                <span className="muted">
                  {' '}
                  (line {location.line}
                  {location.column !== undefined ? `, column ${location.column}` : ''})
                </span>
              ) : null}
            </div>
            {location.frame ? (
              <pre>
                <code>{location.frame}</code>
              </pre>
            ) : null}
            {r.error.stack ? (
              <details>
                <summary className="small">Stack</summary>
                <pre>
                  <code>{r.error.stack}</code>
                </pre>
              </details>
            ) : null}
          </div>
        </div>
      ) : null}

      {r.ok ? (
        <div>
          <h4 className="sandbox-h4">Return value</h4>
          <pre>
            <code>{r.returnValue === undefined ? 'undefined' : prettyJson(r.returnValue)}</code>
          </pre>
        </div>
      ) : null}

      <div>
        <h4 className="sandbox-h4">Console</h4>
        {r.logs.length === 0 ? (
          <p className="muted small">No output.</p>
        ) : (
          <div className="stack sandbox-logs" style={{ gap: 2 }}>
            {r.logs.map((l, i) => (
              <div key={i} className={`log-line log-${l.level}`}>
                <span className="log-level">{l.level}</span>
                <span>{l.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h4 className="sandbox-h4">SDK calls</h4>
        {r.calls.length === 0 ? (
          <p className="muted small">None.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Call</th>
                  <th>Arguments</th>
                  <th>Outcome</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {r.calls.map((c) => (
                  <tr key={c.callId} title={compactJson(c.args, 600)}>
                    <td className="mono nowrap">
                      {c.module}.{c.method}
                    </td>
                    <td className="args">{compactJson(c.args, 100)}</td>
                    <td>{c.ok ? <span className="badge badge-success">ok</span> : <span className="badge badge-danger">{c.error?.code ?? 'failed'}</span>}</td>
                    <td className="nowrap">{formatDuration(c.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {r.compiledCode ? (
        <details>
          <summary className="small muted">Compiled JavaScript</summary>
          <pre>
            <code>{r.compiledCode}</code>
          </pre>
        </details>
      ) : null}
      <div className="muted small mono">
        session {outcome.sessionId} · run {outcome.runId}
      </div>
    </div>
  );
}
