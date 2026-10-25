import { app, type BrowserWindow, ipcMain, Notification } from 'electron';
import { noticeText, threadAttention } from '../shared/thread-notice.ts';
import { assertSender } from './security.ts';

const CHANNEL = 'crewkite:thread-attention';
// The renderer is not trusted to pace itself, and a thread that asks for permission and finishes
// within a few seconds would stack two notifications. Main posts one per thread in this window.
const NOTICE_GAP_MS = 5000;

// One call carries the badge count and at most one notice. The renderer decides when a notice is
// due, since it knows which thread is open. Main writes the text and owns the click.
export function installThreadAttention(window: BrowserWindow) {
  // Electron drops the click handler of a notification nothing references, so each one is held
  // until it is clicked or closed.
  const shown = new Set<Notification>();
  const posted = new Map<string, number>();
  ipcMain.removeHandler(CHANNEL);
  ipcMain.handle(CHANNEL, (event, input: unknown) => {
    assertSender(event, window);
    const attention = threadAttention(input);
    if (!attention) throw new Error('The thread notice is invalid.');
    app.setBadgeCount(attention.badge);
    const notice = attention.notice;
    if (!notice || !Notification.isSupported()) return;
    // A monotonic clock, so a wall clock set back cannot hold a thread's notices.
    const now = performance.now();
    // Entries past the gap say nothing more, so the map holds only the last five seconds.
    for (const [taskId, at] of posted) if (now - at >= NOTICE_GAP_MS) posted.delete(taskId);
    if (posted.has(notice.taskId)) return;
    posted.set(notice.taskId, now);
    const notification = new Notification({ title: noticeText(notice) });
    const release = () => shown.delete(notification);
    notification.on('click', () => {
      release();
      if (window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      window.webContents.send('crewkite:open-thread', notice.taskId);
    });
    notification.on('close', release);
    shown.add(notification);
    notification.show();
  });
  window.once('closed', () => {
    ipcMain.removeHandler(CHANNEL);
    for (const notification of shown) notification.close();
    shown.clear();
    app.setBadgeCount(0);
  });
}
