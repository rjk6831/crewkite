import type { ReactNode } from 'react';
import { externalLink } from '../shared/external-link.ts';

// A link that opens in the person's browser through main. The page never navigates itself: the
// click is stopped here and main validates the address again before it opens anything.
export function ExternalLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const target = externalLink(href);
  if (!target) return <span className={className}>{children}</span>;
  return (
    <a
      className={className}
      href={target.href}
      rel="noreferrer noopener"
      title={target.href}
      onClick={(event) => {
        event.preventDefault();
        void window.crewkite?.openLink?.(target.href).catch(() => {});
      }}
      onAuxClick={(event) => event.preventDefault()}
    >
      {children}
    </a>
  );
}
