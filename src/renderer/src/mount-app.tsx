import { initializeAppearance } from './appearance.js'
import { ConfirmHost } from './components/ui/confirm.js'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App.js'
import './styles.css'
import './theme.css'

if (import.meta.env.DEV && new URLSearchParams(location.search).has('fixtures') && new URLSearchParams(location.search).has('perf')) {
  void import('./performance-diagnostics.js').then(module => module.observeFixtureInteractions())
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: false },
    mutations: { retry: 0 }
  }
})

export async function mountApplication(): Promise<void> {
  await initializeAppearance(window.bandbuddy?.appearance, window.bandbuddy?.startup?.snapshot().appearance)
  ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={queryClient}><App /><ConfirmHost /></QueryClientProvider></React.StrictMode>)
}
