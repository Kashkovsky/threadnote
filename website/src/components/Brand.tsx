import {siteHref} from '../lib/site';

export function ThreadnoteMark({compact = false}: {compact?: boolean}) {
  return (
    <a className="brand" href={siteHref()} aria-label="Threadnote home">
      <img alt="" className="brand__mark" src={siteHref('threadnote-logo.svg')} />
      {!compact && (
        <span className="brand__word">
          thread<span>note</span>
        </span>
      )}
    </a>
  );
}
