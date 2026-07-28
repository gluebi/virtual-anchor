import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')

// StrictMode deliberately: the double mount is exactly what breaks visibility
// tracking and observer bookkeeping that lives in effects, so the demo should be
// running under it at all times rather than only in a test.
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
