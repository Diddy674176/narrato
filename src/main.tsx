import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { registerSW } from 'virtual:pwa-register';
import { claimIsolation } from './lib/tts/isolation';

registerSW({ immediate: true });

// Costs one reload on the first visit and buys multi-core speech generation
// for every visit after it.
claimIsolation();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
