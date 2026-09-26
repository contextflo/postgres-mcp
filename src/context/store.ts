import { readFile, stat } from 'node:fs/promises'
import { emptyContextDocument, parseContextFile, type ContextDocument } from './context-file.js'

/**
 * The context file as the tools see it: re-read whenever it changes on disk, so an edit
 * someone makes mid-session shows up on the next tool call without restarting the server.
 *
 * Only the preamble is fixed at startup, because MCP delivers server instructions once,
 * at initialisation.
 */
export class ContextStore {
  readonly path: string | null
  private document: ContextDocument
  private loadedMtimeMs: number | null

  private constructor(path: string | null, document: ContextDocument, mtimeMs: number | null) {
    this.path = path
    this.document = document
    this.loadedMtimeMs = mtimeMs
  }

  static async open(path: string): Promise<ContextStore> {
    const store = new ContextStore(path, emptyContextDocument(), null)
    await store.refresh()
    return store
  }

  /** A fixed document with no file behind it. */
  static inMemory(document: ContextDocument = emptyContextDocument()): ContextStore {
    return new ContextStore(null, document, null)
  }

  /** The document as last loaded. */
  get current(): ContextDocument {
    return this.document
  }

  /** Re-reads the file if it changed since the last load; returns the current document. */
  async refresh(): Promise<ContextDocument> {
    if (this.path === null) return this.document

    let mtimeMs: number | null
    try {
      mtimeMs = (await stat(this.path)).mtimeMs
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      mtimeMs = null
    }

    if (mtimeMs === this.loadedMtimeMs) return this.document

    this.document = mtimeMs === null ? emptyContextDocument() : parseContextFile(await readFile(this.path, 'utf8'))
    this.loadedMtimeMs = mtimeMs
    return this.document
  }
}
