/// <reference types="vite/client" />

import type { BandBuddyApi } from '@shared/bridge.js'

declare global {
  interface Window {
    bandbuddy: BandBuddyApi
  }

  interface HTMLMediaElement {
    preservesPitch: boolean
    webkitPreservesPitch?: boolean
    setSinkId?: (deviceId: string) => Promise<void>
  }
}

export {}
