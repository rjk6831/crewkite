import { createRoot } from 'react-dom/client';

const root = document.getElementById('root');
if (!root) throw new Error('Desktop root is missing.');
createRoot(root).render(
  <main>
    <h1>CrewKite</h1>
    <p>The desktop journey is not implemented.</p>
  </main>,
);
