import { app, BrowserWindow } from 'electron';

await app.whenReady();
const window = new BrowserWindow({
  webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
});
await window.loadURL(
  'data:text/html,<title>CrewKite</title><p>Workspace foundation. The desktop journey is not implemented.</p>',
);
app.on('window-all-closed', () => app.quit());
