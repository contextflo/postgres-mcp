import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  addTableNotes,
  emptyContextDocument,
  parseContextFile,
  type ContextDocument,
  type NewTableNotes,
} from './context-file.js'

/**
 * The context file as the tools see it: re-read whenever it changes on disk, so an edit
 * someone makes mid-session — or a note the agent just added — shows up on the next tool
 * call without restarting the server.
 *
 * Only the preamble is fixed at startup, because MCP delivers server instructions once,
 * at initialisation.
 */
export class ContextStore {
  readonly path: string | null
  /** False when context writes were turned off, or there is no file to write to. */
  readonly writable: boolean
  private document: ContextDocument
  private loadedMtimeMs: number | null
  /** Writes are chained so two notes added at once cannot clobber each other. */
  private pendingWrite: Promise<unknown> = Promise.resolve()

  private constructor(path: string | null, writable: boolean, document: ContextDocument, mtimeMs: number | null) {
    this.path = path
    this.writable = writable
    this.document = document
    this.loadedMtimeMs = mtimeMs
  }

  static async open(path: string, options: { writable: boolean }): Promise<ContextStore> {
    const store = new ContextStore(path, options.writable, emptyContextDocument(), null)
    await store.refresh()
    return store
  }

  /** A fixed document with no file behind it. */
  static inMemory(document: ContextDocument = emptyContextDocument()): ContextStore {
    return new ContextStore(null, false, document, null)
  }

  /** The document as last loaded. */
  get current(): ContextDocument {
    return this.document
  }

  /**
   * Re-reads the file if it changed since the last load; returns the current document.
   * `force` skips the mtime check, for after our own writes: two writes inside one clock
   * tick can leave the mtime unchanged.
   */
  async refresh(force = false): Promise<ContextDocument> {
    if (this.path === null) return this.document

    let mtimeMs: number | null
    try {
      mtimeMs = (await stat(this.path)).mtimeMs
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      mtimeMs = null
    }

    if (!force && mtimeMs === this.loadedMtimeMs) return this.document

    this.document = mtimeMs === null ? emptyContextDocument() : parseContextFile(await readFile(this.path, 'utf8'))
    this.loadedMtimeMs = mtimeMs
    return this.document
  }

  /** Appends notes to the file, creating it if needed. See {@link addTableNotes}. */
  async addNotes(fullyQualifiedName: string, notes: NewTableNotes): Promise<void> {
    const path = this.path
    if (path === null || !this.writable) throw new Error('Context writes are disabled on this server.')

    const write = this.pendingWrite.then(async () => {
      let raw = ''
      try {
        raw = await readFile(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }

      await mkdir(dirname(path), { recursive: true })
      // Write-then-rename, so an editor or a crash never sees a half-written file.
      const temporary = `${path}.${process.pid}.tmp`
      await writeFile(temporary, addTableNotes(raw, fullyQualifiedName, notes), 'utf8')
      await rename(temporary, path)

      await this.refresh(true)
    })

    this.pendingWrite = write.catch(() => {})
    await write
  }
}
