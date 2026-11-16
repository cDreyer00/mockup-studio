import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { daemon } from './client/daemon';
import './styles.css';

daemon.connect();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
