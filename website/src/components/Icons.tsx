import type {SVGProps} from 'react';

export type IconName = 'memory' | 'local' | 'team' | 'graph' | 'manager' | 'obsidian' | 'arrow' | 'check';

export function Icon({name, ...props}: SVGProps<SVGSVGElement> & {name: IconName}) {
  const paths: Record<IconName, React.ReactNode> = {
    memory: (
      <>
        <path d="M8 7.5A3.5 3.5 0 0 1 11.5 4H14v16h-2.5A3.5 3.5 0 0 1 8 16.5c-2.4-.5-4-2.7-4-5s1.6-4.5 4-5Z" />
        <path d="M16 4h2.5A3.5 3.5 0 0 1 22 7.5c2.4.5 4 2.7 4 5s-1.6 4.5-4 5a3.5 3.5 0 0 1-3.5 3.5H16V4Z" />
        <path d="M8 10h3M19 14h3" />
      </>
    ),
    local: (
      <>
        <rect x="4" y="5" width="24" height="18" rx="3" />
        <path d="M10 28h12M16 23v5M9 11l3 3-3 3M15 17h5" />
      </>
    ),
    team: (
      <>
        <circle cx="11" cy="11" r="4" />
        <circle cx="23" cy="12" r="3" />
        <path d="M4 27c0-5 3-8 7-8s7 3 7 8M19 20c4 0 7 2 7 6" />
      </>
    ),
    graph: (
      <>
        <circle cx="7" cy="8" r="3" />
        <circle cx="25" cy="7" r="3" />
        <circle cx="16" cy="25" r="3" />
        <path d="m9.5 9.5 13-1M9 10.5l5.5 12M23.5 9.5l-6 13" />
      </>
    ),
    manager: (
      <>
        <rect x="3" y="5" width="26" height="22" rx="3" />
        <path d="M3 12h26M10 12v15M15 18h9M15 22h5" />
        <circle cx="7" cy="8.5" r=".8" />
      </>
    ),
    obsidian: (
      <>
        <path d="m16 3 9 7-3 16-6 4-8-5-2-15 10-7Z" />
        <path d="m8 25 8-15 6 16M6 10l10 1 9-1M16 11v19" />
      </>
    ),
    arrow: <path d="M5 16h21M20 9l7 7-7 7" />,
    check: <path d="m6 16 6 6L27 7" />,
  };

  return (
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      {paths[name]}
    </svg>
  );
}
