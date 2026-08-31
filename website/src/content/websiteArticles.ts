export interface WebsiteArticle {
  readonly author: string;
  readonly authorUrl?: string;
  readonly body: string;
  readonly highlights: readonly string[];
  readonly kind: 'article';
  readonly publishedAt: string;
  readonly socialImage?: string;
  readonly socialImageAlt?: string;
  readonly slug: string;
  readonly summary: string;
  readonly title: string;
}

export interface WebsiteSocialImage {
  readonly alt: string;
  readonly height: number;
  readonly type: 'image/png';
  readonly url: string;
  readonly width: number;
}

export const websiteArticleSocialImageWidth = 1200;
export const websiteArticleSocialImageHeight = 630;
export const websiteDefaultSiteSocialImage: WebsiteSocialImage = Object.freeze({
  alt: 'Threadnote — your team remembers',
  height: 630,
  type: 'image/png',
  url: 'https://threadnote.io/og.png',
  width: 1200,
});
export const websiteDefaultPostSocialImage: WebsiteSocialImage = Object.freeze({
  alt: "What's new — Threadnote articles and releases",
  height: 909,
  type: 'image/png',
  url: 'https://threadnote.io/whats-new-og.png',
  width: 1731,
});

export function websiteSocialImageForArticle(
  article: Pick<WebsiteArticle, 'socialImage' | 'socialImageAlt'>,
): WebsiteSocialImage {
  return article.socialImage && article.socialImageAlt
    ? {
        alt: article.socialImageAlt,
        height: websiteArticleSocialImageHeight,
        type: 'image/png',
        url: new URL(article.socialImage, 'https://threadnote.io/').href,
        width: websiteArticleSocialImageWidth,
      }
    : websiteDefaultPostSocialImage;
}

export function websiteSocialImageForRelease(
  release: Readonly<{socialImage: string; socialImageAlt: string}>,
): WebsiteSocialImage {
  return {
    alt: release.socialImageAlt,
    height: websiteArticleSocialImageHeight,
    type: 'image/png',
    url: new URL(release.socialImage, 'https://threadnote.io/').href,
    width: websiteArticleSocialImageWidth,
  };
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
