import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { hasApi } from './api';
import { App } from './components/App';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

if (!hasApi()) {
  root.innerHTML = '<div class="boot">This page must be opened inside the rpchat desktop app.</div>';
} else {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
