import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// PWA Bloco 1 (base instalável): só registra em produção — em dev
// (`vite dev`) o service worker atrapalharia o HMR sem trazer nenhum
// ganho, já que public/sw.js não faz cache algum (passthrough puro).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.error('Falha ao registrar o service worker:', error)
    })
  })
}
