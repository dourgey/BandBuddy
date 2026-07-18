import path from 'node:path'
import type { StemType } from '@shared/domain.js'

const stemPatterns: Array<[StemType, RegExp]> = [
  ['vocals', /(^|[\s._-])(vocals?|voice|singer|人声|主唱|歌声)([\s._-]|$)/i],
  ['drums', /(^|[\s._-])(drums?|percussion|鼓|鼓组|打击)([\s._-]|$)/i],
  ['bass', /(^|[\s._-])(bass|贝斯|低音)([\s._-]|$)/i],
  ['guitar', /(^|[\s._-])(guitars?|gtr|吉他)([\s._-]|$)/i],
  ['piano', /(^|[\s._-])(piano|keys?|keyboard|钢琴|键盘)([\s._-]|$)/i],
  ['other', /(^|[\s._-])(other|accompaniment|instrumental|伴奏|其他|其它)([\s._-]|$)/i]
]

export function inferStemType(fileName: string): StemType | null {
  const stem = path.basename(fileName, path.extname(fileName)).replace(/[()（）\[\]【】]/g, ' ')
  return stemPatterns.find(([, pattern]) => pattern.test(` ${stem} `))?.[0] ?? null
}
