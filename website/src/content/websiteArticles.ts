export interface WebsiteArticle {
  readonly author: string;
  readonly authorUrl?: string;
  readonly body: string;
  readonly highlights: readonly string[];
  readonly kind: 'article';
  readonly publishedAt: string;
  readonly slug: string;
  readonly summary: string;
  readonly title: string;
}

export interface WebsiteUpdateOrderRef {
  readonly publishedAt: string;
  readonly stableId: string;
}

export function orderWebsiteUpdatesDescending<T extends WebsiteUpdateOrderRef>(updates: readonly T[]): readonly T[] {
  return [...updates].sort(
    (left, right) =>
      Date.parse(right.publishedAt) - Date.parse(left.publishedAt) || left.stableId.localeCompare(right.stableId),
  );
}
