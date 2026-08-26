/// <reference types="vite/client" />

declare module 'virtual:threadnote-performance-evidence' {
  const evidence: import('./content/performance').PerformanceEvidence;
  export default evidence;
}

declare module 'virtual:threadnote-release-notes' {
  const releases: readonly import('../../scripts/site-release-notes').WebsiteRelease[];
  export default releases;
}

declare module 'virtual:threadnote-articles' {
  const articles: readonly import('./content/websiteArticles').WebsiteArticle[];
  export default articles;
}
