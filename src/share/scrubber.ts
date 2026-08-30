export interface ScrubberPattern {
  readonly name: string;
  // When present, applyScrubber can replace every match with this string when
  // redact=true. Credentials intentionally omit placeholders so publish/share
  // paths block instead of relying on best-effort redaction.
  readonly placeholder?: string;
  readonly regex: RegExp;
}

export interface ScrubberResult {
  readonly blocker?: string;
  readonly cleaned: string;
  readonly redactions: ReadonlyArray<{readonly count: number; readonly name: string}>;
}

export interface ScrubberOptions {
  readonly additionalPatterns?: readonly ScrubberPattern[];
  readonly redact: boolean;
}

export const SCRUBBER_PATTERNS: readonly ScrubberPattern[] = [
  {name: 'private key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/},
  {name: 'API key (sk-...)', regex: /\bsk-[A-Za-z0-9_-]{16,}/},
  {name: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9_]{16,}/},
  {name: 'GitHub fine-grained PAT', regex: /\bgithub_pat_[A-Za-z0-9_]{20,}/},
  {name: 'GitLab PAT', regex: /\bglpat-[A-Za-z0-9_-]{20,}/},
  {name: 'bearer token', regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i},
  {name: 'basic auth header', regex: /\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}\b/i},
  {name: 'JWT', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/},
  {name: 'AWS access key', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/},
  {name: 'AWS secret access key', regex: /\baws_secret_access_key\s*[:=]\s*["']?[A-Za-z0-9/+=]{35,}["']?/i},
  {name: 'AWS session token', regex: /\baws_session_token\s*[:=]\s*["']?[A-Za-z0-9/+=]{40,}["']?/i},
  {name: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/},
  {name: 'Google OAuth token', regex: /\bya29\.[0-9A-Za-z_-]{20,}/},
  {name: 'Stripe key', regex: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/},
  {name: 'Stripe webhook secret', regex: /\bwhsec_[0-9A-Za-z]{16,}\b/},
  {
    name: 'Discord token',
    regex: /\b(?:mfa\.[A-Za-z0-9_-]{20,}|[MN][A-Za-z0-9_-]{23}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,})\b/,
  },
  {
    name: 'Discord webhook',
    regex: /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/i,
  },
  {name: 'Slack token', regex: /\bx(?:app|ox[abcdeprs])(?:-\d-)?[A-Za-z0-9._-]{10,}/i},
  {name: 'Slack webhook', regex: /https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+/i},
  {
    name: 'database URI',
    regex: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/[^:\s/@]+:[^@\s]+@[^\s)>"'`,]+/i,
  },
  {name: 'URL basic auth', regex: /\bhttps?:\/\/[^:\s/@]+:[^@\s]+@[^\s)>"'`,]+/i},

  {
    name: 'macOS home path',
    placeholder: '<local-path>',
    // Match a real POSIX macOS home root, not Git-Bash/WSL/Windows path
    // fragments such as /c/Users, /mnt/c/Users, or C:/Users.
    regex: /(?<![A-Za-z0-9_:])\/Users\/[^\s)>"'`,]+/,
  },
  {name: 'linux home path', placeholder: '<local-path>', regex: /\/home\/[^\s)>"'`,]+/},
  {
    name: 'Cursor workspace path',
    placeholder: '<local-path>',
    regex: /(?<![A-Za-z0-9_])\/(?:workspace|workspaces)(?:\/[^\s)>"'`,]+)*/i,
  },
  {
    name: 'temporary path',
    placeholder: '<local-path>',
    regex: /(?<![A-Za-z0-9_])\/(?:private\/)?tmp(?:\/[^\s)>"'`,]+)*/i,
  },
  {
    name: 'Windows absolute path',
    placeholder: '<local-path>',
    regex:
      /(?<![A-Za-z0-9_])(?:[A-Za-z]:[\\/][^\s)>"'`,]+|\/[A-Za-z]\/(?:Users|Documents and Settings)[\\/][^\s)>"'`,]+|\\\\[^\\/\s]+[\\/][^\s)>"'`,]+)/i,
  },
  {
    name: 'WSL mounted drive path',
    placeholder: '<local-path>',
    regex: /(?<![A-Za-z0-9_])\/mnt\/[A-Za-z]\/[^\s)>"'`,]+/i,
  },
];

export function applyScrubber(content: string, options: ScrubberOptions): ScrubberResult {
  let cleaned = content;
  const redactions: Array<{count: number; name: string}> = [];
  const patterns = [...SCRUBBER_PATTERNS, ...(options.additionalPatterns ?? [])];
  for (const pattern of patterns) {
    if (!matchesPattern(pattern.regex, cleaned)) {
      continue;
    }
    if (!pattern.placeholder || !options.redact) {
      return {blocker: pattern.name, cleaned: content, redactions: []};
    }
    const globalRegex = globalize(pattern.regex);
    const matches = cleaned.match(globalRegex) ?? [];
    cleaned = cleaned.replace(globalRegex, pattern.placeholder);
    redactions.push({count: matches.length, name: pattern.name});
  }
  return {cleaned, redactions};
}

export function scrubberBlocker(content: string): string | undefined {
  return applyScrubber(content, {redact: false}).blocker;
}

export function detectSecretMatches(content: string): readonly string[] {
  const matches: string[] = [];
  for (const pattern of SCRUBBER_PATTERNS) {
    if (matchesPattern(pattern.regex, content)) {
      matches.push(pattern.name);
    }
  }
  return matches;
}

export function credentialScrubberBlocker(content: string): string | undefined {
  for (const pattern of SCRUBBER_PATTERNS) {
    if (pattern.placeholder === undefined && matchesPattern(pattern.regex, content)) {
      return pattern.name;
    }
  }
  return undefined;
}

export function redactSensitiveText(content: string): string {
  let redacted = content.replace(
    /([A-Za-z0-9_.-]*(?:token|secret|password|api[_-]?key|authorization|credential|session)[A-Za-z0-9_.-]*\s*[:=]\s*)("[^"]+"|'[^']+'|Bearer\s+[^'"\s]+|\S+)/gi,
    '$1[REDACTED]',
  );
  for (const pattern of SCRUBBER_PATTERNS) {
    const placeholder = pattern.placeholder ?? '<secret>';
    redacted = redacted.replace(globalize(pattern.regex), placeholder);
  }
  return redacted;
}

function globalize(regex: RegExp): RegExp {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  return new RegExp(regex.source, flags);
}

function matchesPattern(regex: RegExp, content: string): boolean {
  return new RegExp(regex.source, regex.flags).test(content);
}
