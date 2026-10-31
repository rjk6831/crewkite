/**
 * The one frame navigation the window allows: a frame inside the page loading its own `srcdoc`.
 * The share preview uses it, and every other frame navigation stays cancelled. A main frame never
 * qualifies, and neither does any address the page could name.
 */
export const allowsFrameNavigation = (details: { url: string; isMainFrame: boolean }): boolean =>
  !details.isMainFrame && details.url === 'about:srcdoc';
