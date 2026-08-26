import {useRef, useState} from 'react';

export function PostShare({title, url}: {readonly title: string; readonly url: string}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [copyStatus, setCopyStatus] = useState('Copy link');
  const shareText = encodeURIComponent(title);
  const shareUrl = encodeURIComponent(url);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url);
      setCopyStatus('Copied');
    } catch {
      inputRef.current?.focus();
      inputRef.current?.select();
      setCopyStatus('Select and copy');
    }
  };

  return (
    <section className="post-share" aria-labelledby="post-share-title">
      <div>
        <span className="eyebrow" id="post-share-title">
          Share this post
        </span>
        <label htmlFor="post-share-url">Permanent public URL</label>
      </div>
      <div className="post-share__target">
        <input
          id="post-share-url"
          ref={inputRef}
          readOnly
          value={url}
          onFocus={event => event.currentTarget.select()}
        />
        <button type="button" onClick={() => void copy()}>
          {copyStatus}
        </button>
      </div>
      <div className="post-share__platforms" aria-label="Share on a social platform">
        <a href={`https://x.com/intent/post?text=${shareText}&url=${shareUrl}`} target="_blank" rel="noreferrer">
          Share on X
        </a>
        <a href={`https://www.linkedin.com/sharing/share-offsite/?url=${shareUrl}`} target="_blank" rel="noreferrer">
          Share on LinkedIn
        </a>
      </div>
      <p className="sr-only" aria-live="polite">
        {copyStatus === 'Copy link' ? '' : copyStatus}
      </p>
    </section>
  );
}
