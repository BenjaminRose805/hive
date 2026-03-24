/**
 * Discord thread lifecycle manager for per-task threading.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from 'fs'
import { join, dirname } from 'path'
import { ThreadMapping } from './types.ts'

export class ThreadManager {
  private threads: Map<string, ThreadMapping> = new Map()
  private persistPath: string
  private _mutex: Promise<void> = Promise.resolve()
  private _persistTimer: ReturnType<typeof setTimeout> | null = null

  constructor(hiveRoot: string) {
    this.persistPath = join(hiveRoot, 'state', 'threads.json')
    this.restore()
  }

  async createTaskThread(channel: any, agent: string, taskId: string): Promise<string> {
    return this.withMutex(async () => {
      const existing = this.threads.get(taskId)
      if (existing) return existing.threadId

      const thread = await channel.threads.create({
        name: `${agent}: ${taskId}`,
        autoArchiveDuration: 1440,
      })

      const mapping: ThreadMapping = {
        taskId,
        threadId: thread.id,
        agent,
        createdAt: new Date().toISOString(),
      }
      this.threads.set(taskId, mapping)
      this.schedulePersist()
      return thread.id
    })
  }

  getThread(taskId: string): string | null {
    return this.threads.get(taskId)?.threadId ?? null
  }

  removeThread(taskId: string): void {
    this.threads.delete(taskId)
    this.schedulePersist()
  }

  getAll(): ThreadMapping[] {
    return Array.from(this.threads.values())
  }

  private async withMutex<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void
    const next = new Promise<void>(resolve => { release = resolve })
    const prev = this._mutex
    this._mutex = next
    await prev
    try {
      return await fn()
    } finally {
      release!()
    }
  }

  private schedulePersist(): void {
    if (this._persistTimer) clearTimeout(this._persistTimer)
    this._persistTimer = setTimeout(() => this.persist(), 300)
  }

  private persist(): void {
    const data = JSON.stringify(Array.from(this.threads.values()), null, 2)
    const dir = dirname(this.persistPath)
    mkdirSync(dir, { recursive: true })
    const tmp = `${this.persistPath}.tmp`
    writeFileSync(tmp, data)
    renameSync(tmp, this.persistPath)
  }

  private restore(): void {
    if (!existsSync(this.persistPath)) return
    try {
      const raw = readFileSync(this.persistPath, 'utf-8')
      const entries: ThreadMapping[] = JSON.parse(raw)
      for (const entry of entries) {
        this.threads.set(entry.taskId, entry)
      }
    } catch (err) {
      console.error(`[ThreadManager] Failed to restore from ${this.persistPath}, starting empty:`, err)
    }
  }
}
