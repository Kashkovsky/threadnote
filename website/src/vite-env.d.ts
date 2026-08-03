/// <reference types="vite/client" />

declare module 'virtual:threadnote-performance-evidence' {
  const evidence: import('./content/performance').PerformanceEvidence;
  export default evidence;
}
