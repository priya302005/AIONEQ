import { useParams, Link, Navigate } from 'react-router-dom'
import Logo from '../Logo.jsx'
import { getMemoryType } from '../memoryTypes.jsx'
import UploadForm from '../components/UploadForm.jsx'

function UploadPage() {
  const { type } = useParams()
  const memoryType = getMemoryType(type)

  if (!memoryType) {
    return <Navigate to="/dashboard" replace />
  }

  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <div className="auth-head">
          <div className="logo-badge">
            <Logo size={44} wordmark={false} />
          </div>
          <span className="auth-eyebrow">ADD A MEMORY</span>
          <h2>Preserve a {memoryType.title}</h2>
          <p>{memoryType.desc}</p>
        </div>

        <UploadForm memoryType={memoryType} />

        <p className="auth-switch">
          <Link to="/dashboard" className="auth-link">← Back to Dashboard</Link>
        </p>
      </div>
    </main>
  )
}

export default UploadPage