import { createContext, useContext, useState } from 'react'
import Toaster from './Toaster.jsx'

const ToastContext = createContext(null)

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const notify = (message, type = 'success') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, message, type }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500)
  }

  return (
    <ToastContext.Provider value={{ notify }}>
      {children}
      <Toaster toasts={toasts} />
    </ToastContext.Provider>
  )
}

export function useToast() {
  return useContext(ToastContext)
}