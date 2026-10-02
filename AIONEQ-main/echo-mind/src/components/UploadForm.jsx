import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import VoiceRecorder from './VoiceRecorder.jsx'

function todayISO() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const ACCEPT = {
  voice: 'audio/*',
  document: '.pdf,.doc,.docx,.xls,.xlsx,.rtf,.txt,.md,.csv',
}

const MAX_FILE_BYTES = 25 * 1024 * 1024
const EXTENSIONS = {
  voice: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'webm', 'mp4', 'oga'],
  document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'rtf', 'txt', 'md', 'csv'],
}

/**
 * Client-side size/type gate (UX guard only - the backend performs the real
 * validation, including content sniffing and quota checks).
 * Returns an error message or '' if acceptable.
 */
export function validateFileClient(candidate, type) {
  if (!candidate) return 'Please choose a file.'
  if (candidate.size > MAX_FILE_BYTES) return 'File is too large. The maximum size is 25MB.'
  const ext = (candidate.name.split('.').pop() || '').toLowerCase()
  const allowed = EXTENSIONS[type] || []
  const mimeOk = type === 'voice' ? String(candidate.type || '').startsWith('audio/') : true
  if (!allowed.includes(ext) && !mimeOk) return 'Unsupported file type.'
  return ''
}

function formatFileSize(bytes) {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function Dropzone({ memoryType, file, setFile }) {
  const [dragging, setDragging] = useState(false)
  const [reject, setReject] = useState('')

  // Client-side checks are UX only - the backend independently re-validates
  // magic bytes, size, and quota (never trust the client).
  const pick = (candidate) => {
    const err = validateFileClient(candidate, memoryType.type)
    if (err) {
      setReject(err)
      setFile(null)
      return
    }
    setReject('')
    setFile(candidate)
  }

  return (
    <label
      className={`dropzone ${dragging ? 'dragging' : ''} ${file ? 'has-file' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        if (e.dataTransfer.files?.[0]) pick(e.dataTransfer.files[0])
      }}
    >
      <input
        type="file"
        accept={ACCEPT[memoryType.type]}
        onChange={(e) => pick(e.target.files?.[0] || null)}
      />
      {reject && <span className="dropzone-sub" role="alert" style={{ color: 'var(--danger, #b3372e)' }}>{reject}</span>}
      {file ? (
        <>
          <span className="dropzone-file">{file.name}</span>
          <span className="dropzone-sub">{formatFileSize(file.size)} — click to change</span>
        </>
      ) : (
        <>
          <span className="dropzone-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2" />
              <path d="M12 12v9" />
              <path d="m8 16 4-4 4 4" />
            </svg>
          </span>
          <span className="dropzone-title">Drag & drop your {memoryType.type === 'voice' ? 'recording' : 'file'} here, or click to browse</span>
          <span className="dropzone-sub">Audio or documents up to 25MB</span>
        </>
      )}
    </label>
  )
}

function UploadForm({ memoryType, onSaved }) {
  const navigate = useNavigate()
  const isVoice = memoryType.type === 'voice'
  const [mode, setMode] = useState(isVoice ? 'record' : 'upload')
  const [title, setTitle] = useState('')
  const [eventDate, setEventDate] = useState(todayISO())
  const [tags, setTags] = useState('')
  const [content, setContent] = useState('')
  const [file, setFile] = useState(null)
  const [recording, setRecording] = useState(null)
  const [transcript, setTranscript] = useState('')
  const [banner, setBanner] = useState(null)
  const [loading, setLoading] = useState(false)

  const saveDisabled =
    loading ||
    !title.trim() ||
    (memoryType.fileBased
      ? isVoice && mode === 'record'
        ? !recording
        : !file
      : !content.trim())

  async function handleSubmit(e) {
    e.preventDefault()
    setBanner(null)
    if (!title.trim()) {
      setBanner({ type: 'error', message: 'Please add a title for this memory.' })
      return
    }
    if (memoryType.fileBased && !(isVoice && mode === 'record')) {
      const err = validateFileClient(file, memoryType.type)
      if (err) {
        setBanner({ type: 'error', message: err })
        return
      }
    }
    setLoading(true)
    try {
      let body
      let options
      if (isVoice && mode === 'record') {
        if (!recording) throw new Error('Please record a voice note before saving.')
        const isMp4 = /mp4/.test(recording.blob.type)
        const ext = isMp4 ? 'm4a' : 'webm'
        const audioFile = new File([recording.blob], `recording-${Date.now()}.${ext}`, {
          type: recording.blob.type,
        })
        body = new FormData()
        body.append('type', memoryType.type)
        body.append('title', title.trim())
        body.append('eventDate', eventDate)
        body.append('tags', tags)
        body.append('file', audioFile)
        if (transcript.trim()) body.append('content', transcript.trim())
        options = { method: 'POST', body }
      } else if (memoryType.fileBased) {
        if (!file) throw new Error('Please attach an audio or document file.')
        body = new FormData()
        body.append('type', memoryType.type)
        body.append('title', title.trim())
        body.append('eventDate', eventDate)
        body.append('tags', tags)
        body.append('file', file)
        options = { method: 'POST', body }
      } else {
        if (!content.trim()) throw new Error('Please write the content of this memory.')
        body = JSON.stringify({
          type: memoryType.type,
          title: title.trim(),
          eventDate,
          content,
          tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        })
        options = { method: 'POST', body }
      }
      await api('/api/memories', options)
      setBanner({ type: 'success', message: 'Memory saved successfully.' })
      setTimeout(() => {
        onSaved?.()
        navigate('/dashboard', { replace: true })
      }, 1000)
    } catch (err) {
      setBanner({ type: 'error', message: err.message })
      window.scrollTo(0, 0)
    } finally {
      setLoading(false)
    }
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      {banner && (
        <p className={`auth-banner ${banner.type}`} role="status">
          {banner.message}
        </p>
      )}

      <label className="auth-field">
        <span>Title</span>
        <input
          type="text"
          placeholder="A name for this memory"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>

      <label className="auth-field">
        <span>Date it happened</span>
        <input
          type="date"
          value={eventDate}
          onChange={(e) => setEventDate(e.target.value)}
        />
      </label>

      <label className="auth-field">
        <span>Tags <em className="auth-hint">(optional, comma-separated)</em></span>
        <input
          type="text"
          placeholder="family, trip, 2019"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />
      </label>

      {isVoice && (
        <div className="seg-toggle" role="tablist" aria-label="Add a voice memory">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'record'}
            className={`seg-btn ${mode === 'record' ? 'active' : ''}`}
            onClick={() => setMode('record')}
          >
            🎙 Record
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'upload'}
            className={`seg-btn ${mode === 'upload' ? 'active' : ''}`}
            onClick={() => setMode('upload')}
          >
            📁 Upload file
          </button>
        </div>
      )}

      {memoryType.fileBased ? (
        isVoice && mode === 'record' ? (
          <VoiceRecorder
            onRecordingComplete={(blob) => setRecording(blob ? { blob } : null)}
            onTranscriptChange={setTranscript}
            transcript={transcript}
          />
        ) : (
          <Dropzone memoryType={memoryType} file={file} setFile={setFile} />
        )
      ) : (
        <label className="auth-field">
          <span>{memoryType.type === 'story' ? 'Your story' : 'Content'}</span>
          <textarea
            rows={7}
            placeholder={memoryType.type === 'email' ? 'Dear someone…' : 'Write it down, just as you remember it.'}
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
        </label>
      )}

      <button
        type="submit"
        className="btn-cta auth-submit btn-pill"
        disabled={saveDisabled}
      >
        {loading ? 'Saving…' : 'Save Memory'}
      </button>
      <p className="auth-terms">
        Your memories are encrypted and only visible to people you grant access to.
      </p>
    </form>
  )
}

export default UploadForm