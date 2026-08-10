import type {SVGProps} from 'react';

export type IconName =
  'memory' | 'local' | 'team' | 'graph' | 'manager' | 'obsidian' | 'arrow' | 'check' | 'github' | 'x';

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
    github: (
      <path
        fill="currentColor"
        stroke="none"
        transform="translate(4 4) scale(1.5)"
        d="M8 0C3.58 0 0 3.64 0 8.13c0 3.59 2.29 6.64 5.47 7.71.4.08.55-.18.55-.39 0-.19-.01-.82-.01-1.49-2.01.44-2.44-.87-2.44-.87-.33-.87-.82-1.1-.82-1.1-.67-.47.05-.46.05-.46.74.05 1.13.77 1.13.77.66 1.15 1.73.82 2.15.63.07-.49.26-.82.47-1.01-1.6-.19-3.29-.82-3.29-3.62 0-.8.28-1.45.74-1.96-.07-.18-.32-.93.07-1.93 0 0 .61-.2 1.99.75A6.8 6.8 0 0 1 8 4.68c.62 0 1.23.08 1.8.25 1.38-.95 1.99-.75 1.99-.75.39 1 .14 1.75.07 1.93.46.51.74 1.16.74 1.96 0 2.81-1.69 3.43-3.3 3.61.27.24.49.7.49 1.42 0 1.03-.01 1.86-.01 2.12 0 .21.15.47.55.39A8.16 8.16 0 0 0 16 8.13C16 3.64 12.42 0 8 0Z"
      />
    ),
    x: (
      <path
        fill="currentColor"
        stroke="none"
        transform="translate(4 4)"
        d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.451-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z"
      />
    ),
  };

  return (
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      {paths[name]}
    </svg>
  );
}
