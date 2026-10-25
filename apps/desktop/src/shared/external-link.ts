// The one definition of which addresses the app will hand to the person's browser. The renderer
// uses it to decide whether a model-written link is clickable. Main runs it again on every request,
// because the renderer is not trusted.

export type ExternalLink = { href: string; secure: boolean };
export type OpenLinkResult = 'opened' | 'declined' | 'refused';

const MAX_LINK_LENGTH = 2048;
// Whitespace and control characters never belong in an address, and they hide where a link goes.
const unsafe = (value: string) =>
  [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code <= 0x20 || (code >= 0x7f && code <= 0x9f);
  });

export function externalLink(value: unknown): ExternalLink | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LINK_LENGTH)
    return null;
  if (unsafe(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // user:password@host reads as a trusted host while pointing at another one.
  if (url.username !== '' || url.password !== '' || url.hostname === '') return null;
  return { href: url.href, secure: url.protocol === 'https:' };
}
