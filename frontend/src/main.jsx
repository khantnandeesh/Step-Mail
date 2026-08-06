import { lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './index.css'
import App from './App.jsx'

const AdminDashboard = lazy(() => import('./AdminDashboard.jsx'))

function RouteFallback() {
  return <div style={{ minHeight: '100vh', background: '#f6f7f9' }} />
}

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/active" element={<AdminDashboard />} />
      </Routes>
    </Suspense>
  </BrowserRouter>
)