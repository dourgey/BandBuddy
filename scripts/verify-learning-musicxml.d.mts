export interface MusicXmlValidationResult {
  errors: string[]
  measures: number
  notes: number
}

/** Checks musical timing, instrument references and ties; does not perform XSD validation. */
export function validateMusicXml(xml: string, label?: string): MusicXmlValidationResult
