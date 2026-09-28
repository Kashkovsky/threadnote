/** Inherited process environment for Effect tests that must mutate child-process env. */
export function inheritedProcessEnvironment(): NodeJS.ProcessEnv {
  return process.env;
}
