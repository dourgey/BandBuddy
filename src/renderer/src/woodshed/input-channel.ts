/** Choose the channel with a usable signal without jumping between similarly loud inputs. */
export function selectInputChannel(levels: readonly number[], previous: number, requested: number): number {
  if (!levels.length) return 0
  if (requested > 0 && requested <= levels.length) return requested - 1
  let strongest = 0
  for (let index = 1; index < levels.length; index++)
    if (levels[index]! > levels[strongest]!) strongest = index
  const current = Math.max(0, Math.min(previous, levels.length - 1))
  const currentLevel = levels[current]!
  const strongestLevel = levels[strongest]!
  if (strongestLevel < 0.003 || strongest === current) return current
  return currentLevel < 0.003 || strongestLevel > currentLevel * 2 ? strongest : current
}
