type Listener = (peak: number) => void
const listeners = new Map<string, Set<Listener>>()
export function subscribeTrackLevel(id: string, listener: Listener): () => void {
  const set = listeners.get(id) ?? new Set<Listener>(); set.add(listener); listeners.set(id, set)
  return () => { set.delete(listener); if (!set.size) listeners.delete(id) }
}
export function publishTrackLevel(id: string, peak: number): void { listeners.get(id)?.forEach(listener => listener(peak)) }
export function clearTrackLevels(): void { for (const id of listeners.keys()) publishTrackLevel(id, 0) }
