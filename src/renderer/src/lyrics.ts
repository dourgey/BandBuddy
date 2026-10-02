import './lyrics.css'

const card = document.querySelector<HTMLElement>('#lyrics-card')!
const meta = document.querySelector<HTMLElement>('#song-meta')!
const current = document.querySelector<HTMLElement>('#current-lyric')!
const next = document.querySelector<HTMLElement>('#next-lyric')!
let lastCue = ''
let wordNodes: HTMLElement[][] = []

window.desktopLyrics.onUpdate((payload) => {
  card.style.setProperty('--lyric-font-size', `${payload.fontSize ?? 24}px`)
  card.style.setProperty('--lyric-background-opacity', `${1 - Math.max(0, Math.min(100, payload.backgroundTransparency ?? 20)) / 100}`)
  const artist = payload.artist.trim()
  meta.textContent = artist ? `${payload.title} · ${artist}` : payload.title
  const cue = `${payload.title}\n${payload.cueId ?? ''}\n${payload.currentLines.join('\n')}`
  const changed = cue !== lastCue
  if (changed) {
    lastCue = cue
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (!reduced && current.textContent) {
      const outgoing = current.cloneNode(true) as HTMLElement
      outgoing.removeAttribute('id')
      outgoing.classList.add('lyric-outgoing')
      outgoing.style.top = `${current.offsetTop}px`
      outgoing.style.height = `${current.offsetHeight}px`
      card.append(outgoing)
      const motion = outgoing.animate?.([{ opacity: 0.8, transform: 'translateY(0) scale(1)' }, { opacity: 0, transform: 'translateY(-42px) scale(.82)' }], { duration: 380, easing: 'cubic-bezier(.2,.7,.2,1)' })
      if (motion) void motion.finished.then(() => outgoing.remove()).catch(() => outgoing.remove())
      else outgoing.remove()
    }
    current.replaceChildren()
    wordNodes = []
    if (payload.wordLines?.length) {
      current.classList.add('has-word-timing')
      wordNodes = payload.wordLines.map(line => {
        const row = document.createElement('div')
        current.append(row)
        return line.map(word => {
          const span = document.createElement('span')
          span.className = 'lyric-word'
          span.textContent = word.text
          const highlight = document.createElement('span')
          highlight.className = 'lyric-word-highlight'
          highlight.textContent = word.text
          highlight.setAttribute('aria-hidden', 'true')
          span.append(highlight)
          row.append(span)
          return highlight
        })
      })
    } else {
      current.classList.remove('has-word-timing')
      current.textContent = payload.currentLines.join('\n') || payload.title
    }
    next.textContent = payload.nextLines.join('  ·  ')
    if (!reduced) {
      current.getAnimations?.().forEach(a => a.cancel())
      current.animate?.([{ opacity: 0.35, transform: 'translateY(28px) scale(.84)' }, { opacity: 1, transform: 'translateY(0) scale(1)' }], { duration: 420, easing: 'cubic-bezier(.2,.7,.2,1)' })
      next.getAnimations?.().forEach(a => a.cancel())
      next.animate?.([{ opacity: 0, transform: 'translateY(20px) scale(.94)' }, { opacity: 1, transform: 'translateY(0) scale(1)' }], { duration: 420, easing: 'ease-out' })
    }
  }
  payload.wordLines?.forEach((line, i) => line.forEach((word, j) => wordNodes[i]?.[j]?.style.setProperty('--word-progress', `${word.progress * 100}%`)))
  next.toggleAttribute('hidden', payload.nextLines.length === 0)
  card.classList.toggle('is-playing', payload.playing)
  card.style.setProperty('--lyric-progress', `${Math.round(payload.progress * 1000) / 10}%`)
})
