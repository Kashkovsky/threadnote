import {describe, expect, it} from '@effect/vitest';
import * as FC from 'effect/testing/FastCheck';
import {
  canonicalResourceUri,
  InvalidResourceId,
  parseResourceId,
  resourceIdWithoutAnchor,
} from '../../src/storage/resource-id.js';

const segmentBoundaryArbitrary = FC.constantFrom('a', 'Z', '0', '-', '_', '+', 'é', '中', 'क', '😀');
const segmentMiddleArbitrary = FC.constantFrom(
  'a',
  'Z',
  '0',
  '-',
  '_',
  '+',
  ' ',
  '.',
  '#',
  '%',
  '@',
  '[',
  ']',
  '&',
  '=',
  ',',
  ';',
  '$',
  'é',
  '中',
  'क',
  '😀',
);

/**
 * Every value is portable by construction: the fixed prefix avoids dot and
 * Windows-reserved names, the final character is never a space or dot, and
 * the bounded alphabet stays well below the 255-byte limit.
 */
const portableSegmentArbitrary = FC.oneof(
  FC.constantFrom('a', 'Z', '0', 'é', '中', 'क', '😀'),
  FC.tuple(FC.array(segmentMiddleArbitrary, {maxLength: 12}), segmentBoundaryArbitrary).map(
    ([middle, finalCharacter]) => `seg-${middle.join('')}${finalCharacter}`,
  ),
);

const anchorArbitrary = FC.array(
  FC.constantFrom('a', 'Z', '0', ' ', '.', '/', '?', '#', '%', '@', '&', '=', '+', 'é', '中', 'क', '😀', 'e\u0301'),
  {maxLength: 16, minLength: 1},
).map(parts => parts.join(''));

const optionalAnchorArbitrary = FC.option(anchorArbitrary, {nil: undefined});

type InvalidUriMutation =
  | 'bad_percent'
  | 'duplicate_separator'
  | 'encoded_backslash'
  | 'encoded_nul'
  | 'encoded_separator'
  | 'non_nfc'
  | 'query'
  | 'reserved_name'
  | 'trailing_dot'
  | 'traversal'
  | 'wrong_scheme';

const invalidUriMutationArbitrary = FC.constantFrom<InvalidUriMutation>(
  'bad_percent',
  'duplicate_separator',
  'encoded_backslash',
  'encoded_nul',
  'encoded_separator',
  'non_nfc',
  'query',
  'reserved_name',
  'trailing_dot',
  'traversal',
  'wrong_scheme',
);

type InvalidSegmentMutation =
  'control' | 'encoded_separator_value' | 'non_nfc' | 'reserved_name' | 'too_long' | 'trailing_dot';

const invalidSegmentMutationArbitrary = FC.constantFrom<InvalidSegmentMutation>(
  'control',
  'encoded_separator_value',
  'non_nfc',
  'reserved_name',
  'too_long',
  'trailing_dot',
);

describe('ResourceId properties', () => {
  it('rejects the minimized encoded-separator constructor counterexample', () => {
    expect(() => canonicalResourceUri('resources', ['seg-a/escape'])).toThrow(InvalidResourceId);
  });

  it('rejects the minimized control-anchor constructor counterexample', () => {
    expect(() => canonicalResourceUri('resources', ['safe'], 'a\0')).toThrow(InvalidResourceId);
  });

  it.prop(
    'round-trips every generated canonical identifier and removes anchors idempotently',
    {
      anchor: optionalAnchorArbitrary,
      namespace: portableSegmentArbitrary,
      segments: FC.array(portableSegmentArbitrary, {maxLength: 6}),
    },
    ({anchor, namespace, segments}) => {
      const canonicalUri = canonicalResourceUri(namespace, segments, anchor);
      const parsed = parseResourceId(canonicalUri);

      expect(parsed).toEqual({
        ...(anchor === undefined ? {} : {anchor}),
        canonicalUri,
        inputScheme: 'threadnote',
        namespace,
        segments,
      });
      expect(parseResourceId(parsed.canonicalUri)).toEqual(parsed);

      const withoutAnchor = resourceIdWithoutAnchor(parsed);
      expect(withoutAnchor.anchor).toBeUndefined();
      expect(withoutAnchor.canonicalUri).toBe(canonicalResourceUri(namespace, segments));
      expect(resourceIdWithoutAnchor(withoutAnchor)).toBe(withoutAnchor);
    },
    {fastCheck: {numRuns: 250}},
  );

  it.prop(
    'canonicalizes fully percent-encoded legacy aliases exactly once',
    {
      anchor: optionalAnchorArbitrary,
      namespace: portableSegmentArbitrary,
      segments: FC.array(portableSegmentArbitrary, {maxLength: 6}),
    },
    ({anchor, namespace, segments}) => {
      const encodedPath = segments.map(percentEncodeEveryByte).join('/');
      const legacyUri = `ViKiNg://${percentEncodeEveryByte(namespace)}/${encodedPath}${
        segments.length > 0 ? '/' : ''
      }${anchor === undefined ? '' : `#${percentEncodeEveryByte(anchor)}`}`;
      const expectedCanonical = canonicalResourceUri(namespace, segments, anchor);
      const parsed = parseResourceId(legacyUri);

      expect(parsed.inputScheme).toBe('viking');
      expect(parsed.canonicalUri).toBe(expectedCanonical);
      expect(parseResourceId(parsed.canonicalUri).canonicalUri).toBe(expectedCanonical);
    },
    {fastCheck: {numRuns: 200}},
  );

  it.prop(
    'rejects generated unsafe URI mutations',
    {
      mutation: invalidUriMutationArbitrary,
      namespace: portableSegmentArbitrary,
      segment: portableSegmentArbitrary,
    },
    ({mutation, namespace, segment}) => {
      const encodedNamespace = encodeURIComponent(namespace);
      const encodedSegment = encodeURIComponent(segment);
      const mutated = invalidUriFor(mutation, encodedNamespace, encodedSegment);

      expect(() => parseResourceId(mutated)).toThrow(InvalidResourceId);
    },
    {fastCheck: {numRuns: 150}},
  );

  it.prop(
    'never emits a canonical URI from an invalid segment mutation',
    {
      mutation: invalidSegmentMutationArbitrary,
      segment: portableSegmentArbitrary,
    },
    ({mutation, segment}) => {
      const invalidSegment = invalidSegmentFor(mutation, segment);

      expect(() => canonicalResourceUri('resources', [invalidSegment])).toThrow(InvalidResourceId);
    },
    {fastCheck: {numRuns: 100}},
  );

  it.prop(
    'never emits a canonical URI with a control character in its anchor',
    {
      anchor: anchorArbitrary,
      control: FC.constantFrom('\0', '\n', '\u001f'),
    },
    ({anchor, control}) => {
      expect(() => canonicalResourceUri('resources', ['safe'], `${anchor}${control}`)).toThrow(InvalidResourceId);
    },
    {fastCheck: {numRuns: 50}},
  );
});

function percentEncodeEveryByte(value: string): string {
  return [...Buffer.from(value, 'utf8')].map(byte => `%${byte.toString(16).padStart(2, '0')}`).join('');
}

function invalidUriFor(mutation: InvalidUriMutation, namespace: string, segment: string): string {
  switch (mutation) {
    case 'bad_percent':
      return `threadnote://${namespace}/${segment}/%zz`;
    case 'duplicate_separator':
      return `threadnote://${namespace}/${segment}//child`;
    case 'encoded_backslash':
      return `threadnote://${namespace}/${segment}%5cescape`;
    case 'encoded_nul':
      return `threadnote://${namespace}/${segment}%00suffix`;
    case 'encoded_separator':
      return `threadnote://${namespace}/${segment}%2fescape`;
    case 'non_nfc':
      return `threadnote://${namespace}/${segment}/e%CC%81`;
    case 'query':
      return `threadnote://${namespace}/${segment}?unsafe=true`;
    case 'reserved_name':
      return `threadnote://${namespace}/${segment}/CON.txt`;
    case 'trailing_dot':
      return `threadnote://${namespace}/${segment}.`;
    case 'traversal':
      return `threadnote://${namespace}/${segment}/%2e%2e`;
    case 'wrong_scheme':
      return `file://${namespace}/${segment}`;
  }
}

function invalidSegmentFor(mutation: InvalidSegmentMutation, segment: string): string {
  switch (mutation) {
    case 'control':
      return `${segment}\n`;
    case 'encoded_separator_value':
      return `${segment}/escape`;
    case 'non_nfc':
      return `${segment}e\u0301`;
    case 'reserved_name':
      return 'CON.txt';
    case 'too_long':
      return 'a'.repeat(256);
    case 'trailing_dot':
      return `${segment}.`;
  }
}
