/** Run a .cmd launcher through ComSpec while preserving each argument's boundary. */
export function windowsCommandLauncherInvocation(
  launcher: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): {readonly executable: string; readonly args: readonly string[]} {
  for (const value of [launcher, ...args]) {
    if (/[\0\r\n"]/u.test(value)) throw new Error('Invalid Windows command launcher argument.');
  }
  const quote = (value: string): string => `"${value.replaceAll('%', '%%')}"`;
  return {
    executable: environment.ComSpec ?? environment.COMSPEC ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${[launcher, ...args].map(quote).join(' ')}"`],
  };
}
