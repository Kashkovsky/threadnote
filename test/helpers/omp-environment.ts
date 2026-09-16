export function withoutOmpPathSelectors(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = {...environment};
  delete next.OMP_PROFILE;
  delete next.PI_PROFILE;
  delete next.PI_CODING_AGENT_DIR;
  return next;
}
