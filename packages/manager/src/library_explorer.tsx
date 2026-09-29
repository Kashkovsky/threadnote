import React, {useEffect, useRef} from 'react';
import type {TreeNode} from '@threadnote/manager/ui/contracts';
import {nodeMatches, selectableMemoryUris, treeItemClass} from '@threadnote/manager/ui/support';

const EMPTY_SELECTED_URIS: ReadonlySet<string> = new Set();

export function LibraryExplorer(props: {
  readonly busy: boolean;
  readonly controlsBlocked: boolean;
  readonly filter: string;
  readonly navTreeTab: 'memories' | 'resources';
  readonly onFilter: (filter: string) => void;
  readonly onRefresh: () => void;
  readonly onSelect: (uri: string) => void;
  readonly onShowSystem: (show: boolean) => void;
  readonly onTab: (tab: 'memories' | 'resources') => void;
  readonly onToggleSelection: (node: TreeNode, checked: boolean) => void;
  readonly resourceTree?: TreeNode;
  readonly selectedUri?: string;
  readonly selectedUris: ReadonlySet<string>;
  readonly showSystem: boolean;
  readonly tree?: TreeNode;
}): React.ReactElement {
  return (
    <aside className="library-explorer" aria-label="Memory browser">
      <header>
        <div>
          <p className="eyebrow">Explorer</p>
          <h2>Library</h2>
        </div>
        <button
          aria-label="Refresh memory library"
          className="icon-button"
          disabled={props.busy}
          onClick={props.onRefresh}
          title="Refresh"
          type="button"
        >
          ↻
        </button>
      </header>
      <input
        disabled={props.controlsBlocked}
        value={props.filter}
        onChange={event => props.onFilter(event.target.value)}
        placeholder="Filter memories and folders"
        type="search"
      />
      <div className="nav-tree-tabs" aria-label="Navigation tree">
        <button
          className={props.navTreeTab === 'memories' ? 'is-active' : undefined}
          disabled={props.controlsBlocked}
          onClick={() => props.onTab('memories')}
          type="button"
        >
          Memories
        </button>
        <button
          className={props.navTreeTab === 'resources' ? 'is-active' : undefined}
          disabled={props.controlsBlocked}
          onClick={() => props.onTab('resources')}
          type="button"
        >
          Resources
        </button>
      </div>
      <label className="check-row">
        <input
          checked={props.showSystem}
          disabled={props.controlsBlocked}
          onChange={event => props.onShowSystem(event.target.checked)}
          type="checkbox"
        />
        <span>Show system files</span>
      </label>
      <nav className="tree" aria-label="Context tree">
        {props.navTreeTab === 'resources' ? (
          props.resourceTree ? (
            <Tree
              filter={props.filter}
              node={props.resourceTree}
              onSelect={props.onSelect}
              selectable={false}
              selectedUri={props.selectedUri}
              showSystem={props.showSystem}
            />
          ) : (
            <p className="tree-empty">No resources</p>
          )
        ) : props.tree ? (
          <Tree
            filter={props.filter}
            node={props.tree}
            onSelect={props.onSelect}
            onToggleSelection={props.onToggleSelection}
            selectedUri={props.selectedUri}
            selectedUris={props.selectedUris}
            selectionDisabled={props.busy}
            showSystem={props.showSystem}
          />
        ) : (
          <p className="tree-empty">No memories</p>
        )}
      </nav>
    </aside>
  );
}

function Tree(props: {
  readonly filter: string;
  readonly node: TreeNode;
  readonly onSelect: (uri: string) => void;
  readonly onToggleSelection?: (node: TreeNode, checked: boolean) => void;
  readonly selectable?: boolean;
  readonly selectedUri?: string;
  readonly selectedUris?: ReadonlySet<string>;
  readonly selectionDisabled?: boolean;
  readonly showSystem: boolean;
}): React.ReactElement | null {
  const selectable = props.selectable !== false;
  const selectedUris = props.selectedUris ?? EMPTY_SELECTED_URIS;
  if (!props.showSystem && props.node.isSystem) return null;
  if (props.filter && !nodeMatches(props.node, props.filter)) return null;
  if (props.node.isDir) {
    const selectableUris = selectable
      ? selectableMemoryUris(props.node, {filter: props.filter, showSystem: props.showSystem})
      : [];
    const selectedCount = selectableUris.filter(uri => selectedUris.has(uri)).length;
    const checked = selectableUris.length > 0 && selectedCount === selectableUris.length;
    const indeterminate = selectedCount > 0 && selectedCount < selectableUris.length;
    return (
      <details open={props.node.relativePath.split('/').length < 3}>
        <summary
          className={treeItemClass(props.selectedUri === props.node.uri, !selectable)}
          onClick={() => props.onSelect(props.node.uri)}
          title={props.node.uri}
        >
          {selectable ? (
            <TreeSelectionCheckbox
              checked={checked}
              disabled={props.selectionDisabled === true || selectableUris.length === 0}
              indeterminate={indeterminate}
              onChange={next => props.onToggleSelection?.(props.node, next)}
            />
          ) : null}
          <span aria-hidden="true" className="tree-caret" />
          <span className="tree-name">{props.node.name}</span>
        </summary>
        <div className="tree-children">
          {(props.node.children ?? []).map(child => (
            <Tree {...props} key={child.uri} node={child} />
          ))}
        </div>
      </details>
    );
  }
  return (
    <div className={treeItemClass(props.selectedUri === props.node.uri, !selectable, 'tree-row')}>
      {selectable ? (
        <input
          checked={selectedUris.has(props.node.uri)}
          disabled={props.selectionDisabled === true}
          onChange={event => props.onToggleSelection?.(props.node, event.target.checked)}
          type="checkbox"
        />
      ) : null}
      <button className="tree-file" onClick={() => props.onSelect(props.node.uri)} title={props.node.uri}>
        <span className="tree-name">{props.node.name}</span>
      </button>
    </div>
  );
}

function TreeSelectionCheckbox(props: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly indeterminate: boolean;
  readonly onChange: (checked: boolean) => void;
}): React.ReactElement {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = props.indeterminate;
  }, [props.indeterminate]);
  return (
    <input
      checked={props.checked}
      disabled={props.disabled}
      onChange={event => props.onChange(event.target.checked)}
      onClick={event => event.stopPropagation()}
      ref={ref}
      type="checkbox"
    />
  );
}
