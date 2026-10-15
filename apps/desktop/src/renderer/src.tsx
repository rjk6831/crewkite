import { createRoot } from 'react-dom/client';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/jetbrains-mono/400.css';
import { App } from './app.tsx';
import './style.css';

const root = document.getElementById('root');
if (!root) throw new Error('Desktop root is missing.');
createRoot(root).render(<App />);
