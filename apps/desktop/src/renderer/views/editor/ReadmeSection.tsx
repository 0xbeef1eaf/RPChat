import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { Markdown } from '../../components/common/Markdown';
import { reportError, toast } from '../../store/actions';
import { useDraft, useEditor } from './context';
import { SaveBar } from './SaveBar';

export function ReadmeSection() {
  const { project, setProject } = useEditor();
  const [preview, setPreview] = useState(true);
  const save = useCallback(
    async (draft: { text: string }) => {
      try {
        const p = await api().editor.saveReadme(project.summary.key, draft.text);
        setProject(p);
        toast('success', 'README saved');
        return { text: p.readme };
      } catch (err) {
        reportError('Could not save README', err);
        return null;
      }
    },
    [project.summary.key, setProject],
  );
  const d = useDraft<{ text: string }>({ text: project.readme }, save);
  useEffect(() => {
    d.external({ text: project.readme }, (dr) => dr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.readme]);

  return (
    <div>
      <div className="section-head">
        <h1>README</h1>
        <label className="check small">
          <input type="checkbox" checked={preview} onChange={(e) => setPreview(e.target.checked)} /> preview
        </label>
      </div>
      <div className={preview ? 'split' : undefined}>
        <textarea className="persona" value={d.draft.text} spellCheck onChange={(e) => d.edit({ text: e.target.value })} placeholder="Shown in the Packs view. What is this pack, who is in it, what does it need?" />
        {preview ? (
          <div className="preview">
            <Markdown source={d.draft.text || '_Nothing yet._'} />
          </div>
        ) : null}
      </div>
      <SaveBar dirty={d.dirty} onSave={d.save} onDiscard={() => d.reset({ text: project.readme })} />
    </div>
  );
}
