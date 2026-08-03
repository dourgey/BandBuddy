/// <reference types="vite/client" />

import type { BandBuddyApi, DesktopLyricsRendererApi } from '@shared/bridge.js'

declare global {
  interface Window {
    bandbuddy: BandBuddyApi
    desktopLyrics: DesktopLyricsRendererApi
  }

  interface HTMLMediaElement {
    preservesPitch: boolean
    webkitPreservesPitch?: boolean
  }
}

export {}
