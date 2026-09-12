import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { hasApi } from './api';
import { PromptApp } from './components/prompt/PromptApp';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

if (!hasApi()) {
  root.innerHTML = '<div class="boot">This page must be opened inside the rp-code desktop app.</div>';
} else {
  createRoot(root).render(
    <StrictMode>
      <PromptApp />
    </StrictMode>,
  );
}
