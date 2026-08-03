import { existsSync } from 'node:fs'
import { shell } from 'electron'
import type {
  RehearsalSetDetail,
  RehearsalSetSummary,
  SaveRehearsalRequest
} from '@shared/rehearsal.js'
import type { BandBuddyDatabase } from './database.js'
import type { AppPaths } from './paths.js'

export class RehearsalService {
  constructor(
    private readonly paths: AppPaths,
    private readonly database: BandBuddyDatabase,
    private readonly changed: () => void
  ) {}

  list(): RehearsalSetSummary[] {
    return this.database.listRehearsals()
  }

  get(rehearsalId: string): RehearsalSetDetail | null {
    return this.database.getRehearsal(rehearsalId)
  }

  create(name?: string): RehearsalSetDetail {
    const result = this.database.createRehearsal(name?.trim() || undefined)
    this.changed()
    return result
  }

  save(request: SaveRehearsalRequest): RehearsalSetDetail {
    const result = this.database.saveRehearsal(request)
    this.changed()
    return result
  }

  duplicate(rehearsalId: string, revisionId?: string): RehearsalSetDetail {
    const result = this.database.duplicateRehearsal(rehearsalId, revisionId)
    this.changed()
    return result
  }

  async delete(rehearsalId: string): Promise<void> {
    const rehearsal = this.database.getRehearsal(rehearsalId, false)
    if (!rehearsal) return
    const settings = this.database.getSettings()
    const directory = this.paths.rehearsalDirectory(settings.libraryRoot, rehearsalId)
    if (existsSync(directory)) await shell.trashItem(directory)
    this.database.deleteRehearsalRecord(rehearsalId)
    this.changed()
  }
}
