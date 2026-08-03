import './lyrics.css'

const card = document.querySelector<HTMLElement>('#lyrics-card')!
const meta = document.querySelector<HTMLElement>('#song-meta')!
const current = document.querySelector<HTMLElement>('#current-lyric')!
const next = document.querySelector<HTMLElement>('#next-lyric')!

window.desktopLyrics.onUpdate((payload) => {
  const artist = payload.artist.trim()
  meta.textContent = artist ? `${payload.title} · ${artist}` : payload.title
  current.textContent = payload.currentLines.join('\n') || payload.title
  next.textContent = payload.nextLines.join('  ·  ')
  next.toggleAttribute('hidden', payload.nextLines.length === 0)
  card.classList.toggle('is-playing', payload.playing)
  card.style.setProperty('--lyric-progress', `${Math.round(payload.progress * 1000) / 10}%`)
})
