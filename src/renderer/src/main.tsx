import { startRenderer } from './startup.js'
import './theme-tokens.css'
import './startup.css'

async function start(): Promise<void> {
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('fixtures')) {
    const { installFixtureBridge } = await import('./mock-bridge.js')
    installFixtureBridge()
  }
  // Fetch/parse the application while SQLite is being prepared. Importing this
  // module does not mount React or create an audio engine; startup still owns
  // the readiness gate. Capture load failures until the shell can display them.
  const application = import('./mount-app.js').then(
    module => () => module.mountApplication(),
    error => () => Promise.reject(error)
  )
  await startRenderer(window.bandbuddy, async () => { await (await application)() })
}
void start()
