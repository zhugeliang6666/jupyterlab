// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

/*
  Parts of the implementation of the search in this file were derived from
  CodeMirror's search at:
  https://github.com/codemirror/CodeMirror/blob/c2676685866c571a1c9c82cb25018cc08b4d42b2/addon/search/search.js
  which is licensed with the following license:

  MIT License

  Copyright (C) 2017 by Marijn Haverbeke <marijnh@gmail.com> and others

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in
  all copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
  THE SOFTWARE.
*/

import { CodeEditor } from '@jupyterlab/codeeditor';
import {
  IBaseSearchProvider,
  ISearchMatch,
  TextSearchEngine
} from '@jupyterlab/documentsearch';
import { JSONExt } from '@lumino/coreutils';
import { ISignal, Signal } from '@lumino/signaling';
import * as CodeMirror from 'codemirror';
import { CodeMirrorEditor } from './editor';

type MatchMap = { [key: number]: { [key: number]: ISearchMatch } };

/**
 * CodeMirror search provider for file editor
 */
export class CodeMirrorSearchProvider implements IBaseSearchProvider {
  /**
   * Whether the search provider is disposed or not.
   */
  get isDisposed(): boolean {
    return this._disposed;
  }

  /**
   * Dispose the search provider
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;

    Signal.clearData(this);
  }

  /**
   * Initialize the search using a CodeMirrorEditor object.
   *
   * @param query the search regular expression
   */
  async startQuery(query: RegExp): Promise<void> {
    if (!this.editor) {
      return Promise.resolve();
    }
    return this._startQuery(query);
  }

  /**
   * Refresh the search highlight overlay
   */
  refreshOverlay(): void {
    this._refreshOverlay();
  }

  private async _startQuery(
    query: RegExp,
    refreshOverlay: boolean = true
  ): Promise<void> {
    // no point in removing overlay in the middle of the search
    await this.endQuery(false);

    this._query = query;

    CodeMirror.on(this.editor.doc, 'change', this._onDocChanged.bind(this));
    if (refreshOverlay) {
      this._refreshOverlay();
    }
    await this._setInitialMatches(query);

    const matches = this._parseMatchesFromState();
    if (matches.length === 0) {
      return Promise.resolve();
    }
    const cursorMatch = this._findNext(false);
    const match =
      cursorMatch &&
      this._matchState[cursorMatch.from.line][cursorMatch.from.ch];
    this._currentMatch = match;

    return Promise.resolve();
  }

  /**
   * Clears state of a search provider to prepare for startQuery to be called
   * in order to start a new query or refresh an existing one.
   *
   * @param removeOverlay Whether to remove the search highlight overlay or not.
   */
  async endQuery(removeOverlay = true): Promise<void> {
    this._matchState = {};
    this._currentMatch = null;

    if (removeOverlay) {
      this.editor.removeOverlay(this._overlay);
    }
    const from = this.editor.getCursor('from');
    const to = this.editor.getCursor('to');
    // Setting a reverse selection to allow search-as-you-type to maintain the
    // current selected match.  See comment in _findNext for more details.
    if (from !== to) {
      this.editor.setSelection({
        start: this._toEditorPos(to),
        end: this._toEditorPos(from)
      });
    }
    CodeMirror.off(this.editor.doc, 'change', this._onDocChanged.bind(this));
  }

  /**
   * Clear currently highlighted match.
   */
  clearHighlight(): Promise<void> {
    this._currentMatch = null;
    const cursor = this.editor.getCursorPosition();
    // Reset cursor position to remove any selection
    this.editor.setCursorPosition(cursor);

    return Promise.resolve();
  }

  /**
   * Move the current match indicator to the next match.
   *
   * @param loop Whether to loop within the matches list.
   *
   * @returns A promise that resolves once the action has completed.
   */
  async highlightNext(loop?: boolean): Promise<ISearchMatch | undefined> {
    const cursorMatch = this._findNext(false);
    if (!cursorMatch) {
      return;
    }
    const match = this._matchState[cursorMatch.from.line][cursorMatch.from.ch];
    this._currentMatch = match;
    return match;
  }

  /**
   * Move the current match indicator to the previous match.
   *
   * @param loop Whether to loop within the matches list.
   *
   * @returns A promise that resolves once the action has completed.
   */
  async highlightPrevious(loop?: boolean): Promise<ISearchMatch | undefined> {
    const cursorMatch = this._findNext(true);
    if (!cursorMatch) {
      return;
    }
    const match = this._matchState[cursorMatch.from.line][cursorMatch.from.ch];
    this._currentMatch = match;
    return match;
  }

  /**
   * Replace the currently selected match with the provided text
   *
   * @param newText The replacement text
   * @param loop Whether to loop within the matches list.
   *
   * @returns A promise that resolves with a boolean indicating whether a replace occurred.
   */
  async replaceCurrentMatch(newText: string, loop?: boolean): Promise<boolean> {
    // If the current selection exactly matches the current match,
    // replace it.  Otherwise, just select the next match after the cursor.
    let replaceOccurred = false;
    if (this._currentMatchIsSelected()) {
      const cursor = this.editor.getSearchCursor(
        this._query,
        this.editor.getCursor('from'),
        !this._query.ignoreCase
      );
      if (!cursor.findNext()) {
        return replaceOccurred;
      }
      replaceOccurred = true;
      cursor.replace(newText);
    }
    await this.highlightNext();
    return replaceOccurred;
  }

  /**
   * Replace all matches in the notebook with the provided text
   *
   * @param newText The replacement text
   *
   * @returns A promise that resolves with a boolean indicating whether a replace occurred.
   */
  async replaceAllMatches(newText: string): Promise<boolean> {
    let replaceOccurred = false;
    return new Promise((resolve, _) => {
      this.editor.operation(() => {
        const cursor = this.editor.getSearchCursor(
          this._query,
          undefined,
          !this._query.ignoreCase
        );
        while (cursor.findNext()) {
          replaceOccurred = true;
          cursor.replace(newText);
        }
        this._matchState = {};
        this._currentMatch = null;
        resolve(replaceOccurred);
      });
    });
  }

  /**
   * The list of matches
   */
  get matches(): ISearchMatch[] {
    return this._parseMatchesFromState();
  }

  /**
   * The number of matches.
   */
  get matchesCount(): number | null {
    let size = 0;
    for (const line in this._matchState) {
      size += Object.keys(this._matchState[line]).length;
    }
    return size;
  }

  /**
   * The current match
   */
  get currentMatch(): ISearchMatch | null {
    return this._currentMatch;
  }

  /**
   * Signal indicating that something in the search has changed, so the UI should update
   */
  get stateChanged(): ISignal<this, void> {
    return this._changed;
  }

  /**
   * The current index of the selected match.
   */
  get currentMatchIndex(): number | null {
    if (!this._currentMatch) {
      return null;
    }

    // TODO make it more efficient
    return this.matches.indexOf(this._currentMatch);
  }

  /**
   * Set to true if the widget under search is read-only, false
   * if it is editable.  Will be used to determine whether to show
   * the replace option.
   */
  readonly isReadOnly = false;

  private _onDocChanged(_: any, changeObj: CodeMirror.EditorChange): void {
    // If we get newlines added/removed, the line numbers across the
    // match state are all shifted, so here we need to recalculate it
    if (changeObj.text.length > 1 || (changeObj.removed?.length ?? 0) > 1) {
      this._setInitialMatches(this._query)
        .then(() => {
          this._changed.emit(undefined);
        })
        .catch(reason => {
          console.error(
            `Fail to reapply search on CodeMirror document change:\n${reason}`
          );
        });
    }
  }

  private _refreshOverlay() {
    this.editor.operation(() => {
      // clear search first
      this.editor.removeOverlay(this._overlay);
      this._overlay = this._getSearchOverlay();
      this.editor.addOverlay(this._overlay);
      this._changed.emit(undefined);
    });
  }

  /**
   * Do a full search on the entire document.
   *
   * This manually constructs the initial match state across the whole
   * document. This must be done manually because the codemirror overlay
   * is lazy-loaded, so it will only tokenize lines that are in or near
   * the viewport.  This is sufficient for efficiently maintaining the
   * state when changes are made to the document, as changes occur in or
   * near the viewport, but to scan the whole document, a manual search
   * across the entire content is required.
   *
   * @param query The search term
   */
  private async _setInitialMatches(query: RegExp) {
    this._matchState = {};

    const content = this.editor.doc.getValue();
    const matches = await TextSearchEngine.search(query, content);

    matches.forEach(match => {
      const { line, ch } = this.editor.doc.posFromIndex(match.position);
      if (!this._matchState[line]) {
        this._matchState[line] = {};
      }
      this._matchState[line][ch] = match;
    });
  }

  private _getSearchOverlay() {
    return {
      /**
       * Token function is called when a line needs to be processed -
       * when the overlay is initially created, it's called on all lines;
       * when a line is modified and needs to be re-evaluated, it's called
       * on just that line.
       *
       * This implementation of the token function both constructs/maintains
       * the overlay and keeps track of the match state as the document is
       * updated while a search is active.
       */
      token: (stream: CodeMirror.StringStream) => {
        const currentPos = stream.pos;
        this._query.lastIndex = currentPos;
        const lineText = stream.string;
        const match = this._query.exec(lineText);
        const line = (stream as any).lineOracle.line;

        // If starting at position 0, the tokenization of this line has just started.
        // Blow away everything on this line in the state so it can be updated.
        if (
          stream.start === currentPos &&
          currentPos === 0 &&
          !!this._matchState[line]
        ) {
          this._matchState[line] = {};
        }
        if (match && match.index === currentPos) {
          // found match, add it to state
          const matchLength = match[0].length;
          const matchObj: ISearchMatch = {
            text: lineText.slice(currentPos, currentPos + matchLength),
            position: this.editor.doc.indexFromPos({
              line,
              ch: currentPos
            })
          };
          if (!this._matchState[line]) {
            this._matchState[line] = {};
          }
          this._matchState[line][currentPos] = matchObj;
          // move the stream along and return searching style for the token
          stream.pos += matchLength || 1;

          // if the last thing on the line was a match, make sure we still
          // emit the changed signal so the display can pick up the updates
          if (stream.eol()) {
            this._changed.emit(undefined);
          }
          return 'searching';
        } else if (match) {
          // there's a match in the stream, advance the stream to its position
          stream.pos = match.index;
        } else {
          // no matches, consume the rest of the stream
          this._changed.emit(undefined);
          stream.skipToEnd();
        }
      }
    };
  }

  private _findNext(reverse: boolean): Private.ICodeMirrorMatch | null {
    return this.editor.operation(() => {
      const caseSensitive = this._query.ignoreCase;

      // In order to support search-as-you-type, we needed a way to allow the first
      // match to be selected when a search is started, but prevent the selected
      // search to move for each new keypress.  To do this, when a search is ended,
      // the cursor is reversed, putting the head at the 'from' position.  When a new
      // search is started, the cursor we want is at the 'from' position, so that the same
      // match is selected when the next key is entered (if it is still a match).
      //
      // When toggling through a search normally, the cursor is always set in the forward
      // direction, so head is always at the 'to' position.  That way, if reverse = false,
      // the search proceeds from the 'to' position during normal toggling.  If reverse = true,
      // the search always proceeds from the 'anchor' position, which is at the 'from'.

      const cursorToGet = reverse ? 'anchor' : 'head';
      const lastPosition = this.editor.getCursor(cursorToGet);
      let cursor: CodeMirror.SearchCursor = this.editor.getSearchCursor(
        this._query,
        lastPosition,
        !caseSensitive
      );
      if (!cursor.find(reverse)) {
        // if we do want to loop, try searching from the bottom/top
        const startOrEnd = reverse
          ? CodeMirror.Pos(this.editor.lastLine())
          : CodeMirror.Pos(this.editor.firstLine(), 0);
        cursor = this.editor.getSearchCursor(
          this._query,
          startOrEnd,
          !caseSensitive
        );
        if (!cursor.find(reverse)) {
          return null;
        }
      }
      const fromPos: CodeMirror.Position = cursor.from();
      const toPos: CodeMirror.Position = cursor.to();
      const selRange: CodeEditor.IRange = {
        start: {
          line: fromPos.line,
          column: fromPos.ch
        },
        end: {
          line: toPos.line,
          column: toPos.ch
        }
      };

      this.editor.setSelection(selRange);
      this.editor.scrollIntoView(
        {
          from: fromPos,
          to: toPos
        },
        100
      );
      return {
        from: fromPos,
        to: toPos
      };
    });
  }

  private _parseMatchesFromState(): ISearchMatch[] {
    // Flatten state map
    const matches = new Array<ISearchMatch>();

    for (const lineKey in this._matchState) {
      const lineMatches = this._matchState[lineKey];
      for (const posKey in lineMatches) {
        matches.push(lineMatches[posKey]);
      }
    }

    return matches;
  }

  private _toEditorPos(posIn: CodeMirror.Position): CodeEditor.IPosition {
    return {
      line: posIn.line,
      column: posIn.ch
    };
  }

  private _currentMatchIsSelected(): boolean {
    if (!this._currentMatch) {
      return false;
    }
    const currentSelection = this.editor.getSelection();
    const currentSelectionLength =
      currentSelection.end.column - currentSelection.start.column;
    const selectionIsOneLine =
      currentSelection.start.line === currentSelection.end.line;
    return (
      selectionIsOneLine &&
      this._currentMatch.text.length === currentSelectionLength &&
      this._currentMatch.position ===
        this.editor.doc.indexFromPos({
          line: currentSelection.start.line,
          ch: currentSelection.start.column
        })
    );
  }

  protected editor: CodeMirrorEditor;
  private _query: RegExp;
  private _currentMatch: ISearchMatch | null;
  private _matchState: MatchMap = {};
  private _changed = new Signal<this, void>(this);
  private _disposed = false;
  private _overlay: any;
}

/**
 * Helper class to highlight texts in a code mirror editor.
 *
 * Highlighted texts (aka `matches`) must be provided through
 * the `matches` attributes.
 */
export class CodeMirrorSearchHighlighter {
  /**
   * Constructor
   *
   * @param editor The CodeMirror editor
   */
  constructor(editor: CodeMirrorEditor) {
    this._cm = editor;
    this._matches = new Array<ISearchMatch>();
    this._currentIndex = null;
  }

  /**
   * The current index of the selected match.
   */
  get currentIndex(): number | null {
    return this._currentIndex;
  }

  /**
   * The list of matches
   */
  get matches(): ISearchMatch[] {
    return this._matches;
  }
  set matches(v: ISearchMatch[]) {
    if (!JSONExt.deepEqual(this._matches as any, v as any)) {
      this._matches = v;
    }
    this.refresh();
  }

  /**
   * Clear all highlighted matches
   */
  clearHighlight(): void {
    this._currentIndex = null;
    this._highlightCurrentMatch();
  }

  /**
   * Refresh the highlight matches overlay
   */
  refresh(): void {
    this._refreshOverlay();
  }

  /**
   * Clear the highlighted matches.
   */
  endQuery(): Promise<void> {
    this._currentIndex = null;
    this._matches = [];

    this._cm.removeOverlay('jp-searching');
    this._overlay = null;

    const from = this._cm.getCursor('from');
    const to = this._cm.getCursor('to');
    // Setting a reverse selection to allow search-as-you-type to maintain the
    // current selected match. See comment in _findNext for more details.
    if (from !== to) {
      this._cm.setSelection({
        start: this._toEditorPos(to),
        end: this._toEditorPos(from)
      });
    }

    return Promise.resolve();
  }

  /**
   * Highlight the next match
   *
   * @returns The next match if available
   */
  highlightNext(): Promise<ISearchMatch | undefined> {
    this._currentIndex = this._findNext(false);
    this._highlightCurrentMatch();
    return Promise.resolve(
      this._currentIndex !== null
        ? this._matches[this._currentIndex]
        : undefined
    );
  }

  /**
   * Highlight the previous match
   *
   * @returns The previous match if available
   */
  highlightPrevious(): Promise<ISearchMatch | undefined> {
    this._currentIndex = this._findNext(true);
    this._highlightCurrentMatch();
    return Promise.resolve(
      this._currentIndex !== null
        ? this._matches[this._currentIndex]
        : undefined
    );
  }

  private _highlightCurrentMatch(): void {
    // Highlight the current index
    if (this._currentIndex !== null) {
      const match = this.matches[this._currentIndex];
      this._cm.operation(() => {
        const start = this._cm.doc.posFromIndex(match.position);
        const from = {
          line: start.line,
          column: start.ch
        };
        const to = {
          // Matches is on the same line
          line: start.line,
          column: start.ch + match.text.length
        };
        // No need to scroll into view this is the default behavior
        this._cm.setSelection({
          start: from,
          end: to
        });
      });
    } else {
      // Set cursor to remove any selection
      this._cm.setCursorPosition({ line: 0, column: 0 });
    }
  }

  private _refreshOverlay() {
    // clear search first
    this._cm.removeOverlay('jp-searching');
    this._overlay = this._getSearchOverlay();
    this._cm.addOverlay(this._overlay);
  }

  private _getSearchOverlay() {
    const token = (stream: CodeMirror.StringStream) => {
      const position = this._cm.doc.indexFromPos({
        line: stream.lineOracle.line,
        ch: stream.pos
      });

      let found =
        this._matches.length > 0
          ? Utils.findNext(
              this._matches,
              position,
              0, // lastMatchIndex,
              this._matches.length - 1
            )
          : null;

      if (found !== null) {
        // lastMatchIndex = found;
        const match = this._matches[found];
        if (match.position > position + stream.string.length) {
          // next match not in this stream, consume the rest of the stream
          stream.skipToEnd();
          return null;
        }

        if (position === match.position) {
          // move the stream along and return searching style for the token
          stream.pos += match.text.length || 1;
          return 'searching';
        } else {
          // Move to the next match
          stream.pos += match.position - position;
        }
      } else {
        // no matches, consume the rest of the stream
        stream.skipToEnd();
      }
      return null;
    };

    return {
      name: 'jp-searching',
      /**
       * Token function is called when a line needs to be processed -
       * when the overlay is initially created, it's called on all lines;
       * when a line is modified and needs to be re-evaluated, it's called
       * on just that line.
       *
       * This implementation of the token function both constructs/maintains
       * the overlay and keeps track of the match state as the document is
       * updated while a search is active.
       */
      token: token.bind(this)
    };
  }

  private _findNext(reverse: boolean): number | null {
    if (this._matches.length === 0) {
      // No-op
      return null;
    }
    // In order to support search-as-you-type, we needed a way to allow the first
    // match to be selected when a search is started, but prevent the selected
    // search to move for each new keypress.  To do this, when a search is ended,
    // the cursor is reversed, putting the head at the 'from' position.  When a new
    // search is started, the cursor we want is at the 'from' position, so that the same
    // match is selected when the next key is entered (if it is still a match).
    //
    // When toggling through a search normally, the cursor is always set in the forward
    // direction, so head is always at the 'to' position.  That way, if reverse = false,
    // the search proceeds from the 'to' position during normal toggling.  If reverse = true,
    // the search always proceeds from the 'anchor' position, which is at the 'from'.

    const cursorToGet = reverse ? 'anchor' : 'head';
    let lastPosition = this._cm.getCursor(cursorToGet);
    if (
      lastPosition.line === 0 &&
      lastPosition.ch === 0 &&
      reverse &&
      this.currentIndex === null
    ) {
      // The default position is (0, 0) but we want to start from the end in that case
      lastPosition = {
        // Go to virtual next line so position got clamp to end
        line: this._cm.lineCount,
        ch: 0
      };
    }
    const position = this._cm.doc.indexFromPos(lastPosition);

    let found = Utils.findNext(
      this._matches,
      position,
      0,
      this._matches.length - 1
    );

    if (found === null) {
      // Don't loop
      return reverse ? this._matches.length - 1 : null;
    }

    if (reverse) {
      found -= 1;
      if (found < 0) {
        // Don't loop
        return null;
      }
    }

    return found;
  }

  private _toEditorPos(posIn: CodeMirror.Position): CodeEditor.IPosition {
    return {
      line: posIn.line,
      column: posIn.ch
    };
  }

  private _cm: CodeMirrorEditor;
  private _currentIndex: number | null;
  private _matches: ISearchMatch[];
  private _overlay: any;
}

namespace Private {
  export interface ICodeMirrorMatch {
    from: CodeMirror.Position;
    to: CodeMirror.Position;
  }
}

/**
 * Helpers namespace
 */
namespace Utils {
  /**
   * Find the closest match at `position` just after it.
   *
   * #### Notes
   * Search is done using a binary search algorithm
   *
   * @param matches List of matches
   * @param position Searched position
   * @param lowerBound Lower range index
   * @param higherBound High range index
   * @returns The next match or null if none exists
   */
  export function findNext(
    matches: ISearchMatch[],
    position: number,
    lowerBound = 0,
    higherBound = Infinity
  ): number | null {
    higherBound = Math.min(matches.length - 1, higherBound);

    while (lowerBound <= higherBound) {
      let middle = Math.floor(0.5 * (lowerBound + higherBound));
      const currentPosition = matches[middle].position;

      if (currentPosition < position) {
        lowerBound = middle + 1;
        if (
          lowerBound < matches.length &&
          matches[lowerBound].position > position
        ) {
          return lowerBound;
        }
      } else if (currentPosition > position) {
        higherBound = middle - 1;
        if (higherBound > 0 && matches[higherBound].position < position) {
          return middle;
        }
      } else {
        return middle;
      }
    }

    // Next could be the first item
    const first = lowerBound > 0 ? lowerBound - 1 : 0;
    const match = matches[first];
    return match.position >= position ? first : null;
  }
}
