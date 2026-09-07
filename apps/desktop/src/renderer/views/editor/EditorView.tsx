import { useAppState } from '../../store/store';
import { EditorShell } from './EditorShell';
import { ProjectList } from './ProjectList';

interface EditorViewProps {
  /** The view stays mounted while other routes are shown so drafts survive; hidden when inactive. */
  active: boolean;
}

export function EditorView({ active }: EditorViewProps) {
  const projectKey = useAppState((s) => s.editor.projectKey);
  return (
    <div className="editor-root" hidden={!active}>
      {projectKey ? <EditorShell key={projectKey} projectKey={projectKey} active={active} /> : <ProjectList />}
    </div>
  );
}
