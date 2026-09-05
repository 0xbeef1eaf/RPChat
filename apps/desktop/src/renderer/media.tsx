import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { hasApi } from './api';
import { MediaApp } from './media/MediaApp';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

if (hasApi()) {
  createRoot(root).render(
    <StrictMode>
      <MediaApp />
    </StrictMode>,
  );
}
