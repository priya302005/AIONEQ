import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import './App.css'
import Logo from './Logo.jsx'
import Login from './Login.jsx'
import Signup from './Signup.jsx'
import Home from './Home.jsx'
import ResetPassword from './ResetPassword.jsx'
import UpdatePassword from './UpdatePassword.jsx'
import Dashboard from './pages/Dashboard.jsx'
import UploadPage from './pages/UploadPage.jsx'
import Ask from './pages/Ask.jsx'
import MemoryDetail from './pages/MemoryDetail.jsx'
import RequireAuth from './components/RequireAuth.jsx'
import { AuthProvider, useAuth } from './auth'
import { ToastProvider, useToast } from './toast'
import { supabase } from './supabaseClient'

function useRevealOnScroll(dep) {
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible')
            observer.unobserve(entry.target)
          }
        })
      },
      { threshold: 0.12 }
    )
    document.querySelectorAll('.reveal').forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [dep])
}

const routeFor = (view) =>
  ({ signup: '/signup', login: '/login', 'reset-password': '/reset-password', 'update-password': '/update-password' })[view] || '/'

function initials(name) {
  return name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

function Shell() {
  const navigate = useNavigate()
  const location = useLocation()
  const { user } = useAuth()
  const { notify } = useToast()

  useRevealOnScroll(location.pathname)

  useEffect(() => {
    if (window.location.hash.includes('type=recovery')) {
      window.history.replaceState(null, '', window.location.pathname)
      navigate('/update-password', { replace: true })
    }
  }, [navigate])

  const goSection = (e, id) => {
    e.preventDefault()
    if (location.pathname !== '/') {
      navigate('/')
      setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }), 80)
    } else {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
    }
  }

  const go = (view) => navigate(routeFor(view))
  const logout = async () => {
    try {
      await supabase.auth.signOut()
    } catch {
      await supabase.auth.clearSession().catch(() => {})
    }
    notify('Logged out.')
    navigate('/')
  }

  const displayName = user?.user_metadata?.full_name || user?.email || ''
  const avatarText = displayName ? initials(displayName) : ''

  return (
    <div className="app">
      {/* ===================== NAVBAR ===================== */}
      <nav className="navbar">
        <div className="nav-container">
          <a href="#home" className="nav-logo" onClick={(e) => { e.preventDefault(); navigate('/') }}>
            <Logo size={34} />
          </a>
          <div className="nav-links">
            <a href="#home" onClick={(e) => goSection(e, 'home')}>Home</a>
            <a href="#how-it-works" onClick={(e) => goSection(e, 'how-it-works')}>How It Works</a>
            <a href="#features" onClick={(e) => goSection(e, 'features')}>Features</a>
            <a href="#who" onClick={(e) => goSection(e, 'who')}>Who It's For</a>
            <a href="#about" onClick={(e) => goSection(e, 'about')}>About</a>
          </div>
          <div className="nav-actions">
            {user ? (
              <>
                <span className="nav-user" title={displayName || 'Account'}>
                  <span className="nav-avatar">{avatarText}</span>
                  <span className="nav-username">{displayName || 'Account'}</span>
                </span>
                <button type="button" className="btn-ghost" onClick={logout}>Log Out</button>
              </>
            ) : (
              <>
                <button type="button" className="btn-ghost" onClick={() => navigate('/login')}>
                  Login
                </button>
                <button type="button" className="btn-primary" onClick={() => navigate('/signup')}>
                  Sign Up
                </button>
              </>
            )}
          </div>
        </div>
      </nav>

      <Routes>
        <Route
          path="/"
          element={<Home go={go} />}
        />
        <Route path="/login" element={<Login onSwitch={go} onHome={() => navigate('/dashboard')} notify={notify} />} />
        <Route path="/signup" element={<Signup onSwitch={go} notify={notify} />} />
        <Route path="/reset-password" element={<ResetPassword onSwitch={go} notify={notify} />} />
        <Route path="/update-password" element={<UpdatePassword onSwitch={go} notify={notify} />} />
        <Route
          path="/dashboard"
          element={<RequireAuth><Dashboard /></RequireAuth>}
        />
        <Route
          path="/dashboard/upload/:type"
          element={<RequireAuth><UploadPage /></RequireAuth>}
        />
        <Route
          path="/dashboard/ask"
          element={<RequireAuth><Ask /></RequireAuth>}
        />
        <Route
          path="/dashboard/memories/:id"
          element={<RequireAuth><MemoryDetail /></RequireAuth>}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      {/* ===================== FOOTER ===================== */}
      <footer className="footer">
        <div className="footer-container">
          <div className="footer-top">
            <div className="footer-brand">
              <a href="#home" className="nav-logo" onClick={(e) => { e.preventDefault(); navigate('/') }}>
                <Logo size={30} />
              </a>
              <p className="footer-tagline">
                An AI memory capsule preserving knowledge, experiences, and a way of thinking.
              </p>
            </div>
            <div className="footer-links">
              <div className="footer-col">
                <h4>Product</h4>
                <a href="#gallery" onClick={(e) => goSection(e, 'gallery')}>The Archive</a>
                <a href="#how-it-works" onClick={(e) => goSection(e, 'how-it-works')}>How It Works</a>
                <a href="#features" onClick={(e) => goSection(e, 'features')}>Features</a>
                <a href="#who" onClick={(e) => goSection(e, 'who')}>Who It's For</a>
              </div>
              <div className="footer-col">
                <h4>About</h4>
                <a href="#about" onClick={(e) => goSection(e, 'about')}>Our Mission</a>
                <a href="#privacy" onClick={(e) => goSection(e, 'privacy')}>Privacy</a>
                <a href="#">Contact</a>
                <a href="#">GitHub</a>
              </div>
            </div>
          </div>
          <div className="footer-bottom">
            <span>EchoMind © 2026</span>
            <div className="footer-legal">
              <a href="#">Privacy Policy</a>
              <a href="#">Terms</a>
              <a href="#">Contact</a>
              <a href="#">GitHub</a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  )
}

function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <BrowserRouter>
          <Shell />
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  )
}

export default App