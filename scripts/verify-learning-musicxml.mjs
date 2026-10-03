import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DOMParser } from '@xmldom/xmldom'

const children = (node, tag) => Array.from(node.childNodes ?? []).filter(child => child.nodeType === 1 && (!tag || child.tagName === tag))
const text = (node, tag) => children(node, tag)[0]?.textContent ?? ''
const close = (a, b) => Math.abs(a - b) < 1e-7
const values = { maxima: 32, long: 16, breve: 8, whole: 4, half: 2, quarter: 1, eighth: .5, '16th': .25, '32nd': .125, '64th': .0625, '128th': .03125 }

/** Musical-integrity checks, not a substitute for MusicXML XSD validation. */
export function validateMusicXml(xml, label = 'MusicXML') {
  const errors = []
  let measures = 0, notes = 0
  const doc = new DOMParser({ onError: (level, message) => errors.push(`${label}: ${level}: ${message}`) }).parseFromString(xml, 'application/xml')
  if (doc.documentElement?.tagName !== 'score-partwise') errors.push(`${label}: root must be score-partwise`)
  const instruments = new Set(Array.from(doc.getElementsByTagName('score-instrument'), n => n.getAttribute('id')))
  for (const part of children(doc.documentElement, 'part')) {
    let divisions = 0, measureLength = 0
    const ties = new Map()
    for (const measure of children(part, 'measure')) {
      measures++
      const where = `${label}: part ${part.getAttribute('id')} measure ${measure.getAttribute('number')}`
      let cursor = 0, extent = 0, chordStart = 0, previousDuration = 0
      for (const node of children(measure)) {
        if (node.tagName === 'attributes') {
          if (text(node, 'divisions')) divisions = Number(text(node, 'divisions'))
          const meter = children(node, 'time')[0]
          if (meter) measureLength = text(meter, 'beats').split('+').reduce((sum, n) => sum + Number(n), 0) * 4 / Number(text(meter, 'beat-type'))
          continue
        }
        if (!['note', 'backup', 'forward'].includes(node.tagName)) continue
        if (children(node, 'grace').length) continue
        const rawDuration = Number(text(node, 'duration')), duration = rawDuration / divisions
        if (!(divisions > 0 && rawDuration > 0 && Number.isFinite(duration))) { errors.push(`${where}: invalid duration/divisions`); continue }
        if (node.tagName === 'backup') { cursor -= duration; if (cursor < -1e-7) errors.push(`${where}: backup before measure start`); continue }
        if (node.tagName === 'forward') { cursor += duration; extent = Math.max(cursor, extent); continue }
        notes++
        const chord = children(node, 'chord').length > 0
        if (!chord) { chordStart = cursor; previousDuration = duration; cursor += duration }
        else if (!previousDuration || duration > previousDuration + 1e-7) errors.push(`${where}: chord has no previous note or exceeds its duration`)
        extent = Math.max(extent, cursor, chordStart + duration)
        const type = text(node, 'type')
        const modification = children(node, 'time-modification')[0]
        const dots = children(node, 'dot').length
        const ratio = modification ? Number(text(modification, 'normal-notes')) / Number(text(modification, 'actual-notes')) : 1
        const written = values[type] * (2 - 2 ** -dots) * ratio
        const rest = children(node, 'rest')[0]
        if (type && !close(written, duration) && rest?.getAttribute('measure') !== 'yes') errors.push(`${where}: ${type} with ${dots} dots writes ${written} beats but duration is ${duration}`)
        const kinds = ['rest', 'pitch', 'unpitched'].filter(tag => children(node, tag).length)
        if (kinds.length !== 1) errors.push(`${where}: note must have exactly one pitch, unpitched or rest`)
        const instrument = children(node, 'instrument')[0]?.getAttribute('id')
        if (instrument && !instruments.has(instrument)) errors.push(`${where}: undeclared instrument ${instrument}`)
        const pitch = children(node, 'pitch')[0]
        const key = `${text(node, 'staff') || 1}:${text(node, 'voice') || 1}:${pitch ? `${text(pitch, 'step')}:${text(pitch, 'alter') || 0}:${text(pitch, 'octave')}` : instrument || 'rest'}`
        for (const tie of children(node, 'tie')) {
          if (tie.getAttribute('type') === 'stop') {
            if (!ties.has(key)) errors.push(`${where}: tie stop without matching pitch/voice start (${key})`)
            ties.delete(key)
          }
          if (tie.getAttribute('type') === 'start') ties.set(key, where)
        }
      }
      if (!(measureLength > 0)) errors.push(`${where}: missing or invalid time signature`)
      else if (!close(extent, measureLength) && !(measure.getAttribute('implicit') === 'yes' && extent <= measureLength)) errors.push(`${where}: measure fills ${extent} beats, expected ${measureLength}`)
    }
    for (const [key, where] of ties) errors.push(`${where}: unclosed tie (${key})`)
  }
  if (!measures || !notes) errors.push(`${label}: no measures or notes`)
  return { errors, measures, notes }
}

function xmlFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? xmlFiles(join(directory, entry.name)) : /\.(musicxml|xml)$/i.test(entry.name) ? [join(directory, entry.name)] : [])
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = resolve(process.argv[2] ?? 'resources/learning/scores')
  const files = xmlFiles(directory)
  const results = files.map(file => validateMusicXml(readFileSync(file, 'utf8'), file))
  const errors = results.flatMap(result => result.errors)
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1 }
  else console.log(`MusicXML integrity passed: ${files.length} files, ${results.reduce((sum, r) => sum + r.measures, 0)} measures, ${results.reduce((sum, r) => sum + r.notes, 0)} notes.`)
}
