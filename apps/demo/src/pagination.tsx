import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PaginationDemo } from './PaginationDemo.js'

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')

// StrictMode here too: the double mount is exactly what breaks bookkeeping that lives in
// effects, so both demo pages run under it rather than only the tested one.
createRoot(root).render(
  <StrictMode>
    <PaginationDemo />
  </StrictMode>,
)
