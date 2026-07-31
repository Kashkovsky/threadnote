const base = import.meta.env.BASE_URL;

export function siteHref(path = ''): string {
  const normalized = path.replace(/^\/+/, '');
  return `${base}${normalized}`;
}

export const githubUrl = 'https://github.com/Kashkovsky/threadnote';

export function setDocumentMeta(title: string, description: string): void {
  document.title = `${title} — Threadnote`;
  const descriptionElement = document.querySelector<HTMLMetaElement>('meta[name="description"]');
  if (descriptionElement) {
    descriptionElement.content = description;
  }
}
