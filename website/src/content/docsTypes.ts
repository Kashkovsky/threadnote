export type DocsTextBlock = {
  type: 'paragraph' | 'note' | 'warning';
  text: string;
};

export type DocsHeadingBlock = {
  type: 'heading';
  text: string;
};

export type DocsCodeBlock = {
  type: 'code';
  language?: string;
  code: string;
};

export type DocsListBlock = {
  type: 'list';
  items: string[];
};

export type DocsTableBlock = {
  type: 'table';
  headers: string[];
  rows: string[][];
};

export type DocsBlock = DocsTextBlock | DocsHeadingBlock | DocsCodeBlock | DocsListBlock | DocsTableBlock;

export interface DocsArticle {
  id: string;
  title: string;
  summary: string;
  keywords?: string[];
  body: DocsBlock[];
}

export interface DocsSection {
  id: string;
  title: string;
  description?: string;
  articles: DocsArticle[];
}

export interface CliCommandReference {
  command: string;
  summary: string;
  examples: string[];
}

export interface McpToolReference {
  name: string;
  toolset: 'core' | 'full';
  summary: string;
  keyInputs: string[];
}
