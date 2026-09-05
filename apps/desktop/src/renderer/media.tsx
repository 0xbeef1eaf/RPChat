import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MediaApp } from './media/MediaApp';
import { createTransportForWindow } from './media/transport';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

// Electron (window.rp) or the native layer-shell helper's WebKit view (window.__rpHelper).
const transport = createTransportForWindow(window);

createRoot(root).render(
  <StrictMode>
    <MediaApp transport={transport} />
  </StrictMode>,
);
