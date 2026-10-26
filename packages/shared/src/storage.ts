export interface StorageUsage {
  entries: Array<{ label: string; path: string; bytes: number; incomplete: boolean }>
  totalBytes: number
  freeBytes: number | null
}
