import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')

createRoot(root).render(
  <StrictMode>
    <p>Demo scaffold — the forum thread lands here once the core is built.</p>
  </StrictMode>,
)
