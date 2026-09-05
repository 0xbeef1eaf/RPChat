import { useEffect } from 'react';
import { bootstrap, navigate } from '../store/actions';
import { useAppState } from '../store/store';
import { ActionLogView } from '../views/ActionLogView';
import { ChatView } from '../views/ChatView';
import { PacksView } from '../views/PacksView';
import { SdkReferenceView } from '../views/SdkReferenceView';
import { SettingsView } from '../views/SettingsView';
import { PermissionModal } from './modals/PermissionModal';
import { UiPromptModal } from './modals/UiPromptModal';
import { Sidebar } from './Sidebar';
import { Toasts } from './common/Toasts';

const SHORTCUTS: Record<string, Parameters<typeof navigate>[0]> = { '1': 'chat', '2': 'packs', '3': 'settings', '4': 'log', '5': 'sdk' };

export function App() {
  const route = useAppState((s) => s.route);
  const booting = useAppState((s) => s.booting);
  const bootError = useAppState((s) => s.bootError);

  useEffect(() => {
    void bootstrap();
  }, []);

  // Ctrl/Cmd + 1..5 switches views.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const r = SHORTCUTS[e.key];
      if (r) {
        e.preventDefault();
        navigate(r);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (booting) {
    return (
      <div className="boot">
        <span className="spinner" /> Starting…
      </div>
    );
  }

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        {bootError ? (
          <div className="callout callout-danger" style={{ margin: 12 }}>
            Some data failed to load: {bootError}
          </div>
        ) : null}
        {route === 'chat' ? <ChatView /> : null}
        {route === 'packs' ? <PacksView /> : null}
        {route === 'settings' ? <SettingsView /> : null}
        {route === 'log' ? <ActionLogView /> : null}
        {route === 'sdk' ? <SdkReferenceView /> : null}
      </main>
      <PermissionModal />
      <UiPromptModal />
      <Toasts />
    </div>
  );
}
