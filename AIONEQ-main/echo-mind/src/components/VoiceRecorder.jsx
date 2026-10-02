import { useCallback, useEffect, useRef, useState } from 'react'

const MAX_RECORD_SECONDS = 600
const WAVE_BARS = 42

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return ''
  for (const m of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(m)) return m
  }
  return ''
}

function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds))
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

function VoiceRecorder({ onRecordingComplete, onTranscriptChange, transcript }) {
  const [status, setStatus] = useState('idle') // idle | recording | paused | stopped
  const [elapsed, setElapsed] = useState(0)
  const [recordError, setRecordError] = useState('')
  const [recording, setRecording] = useState(null) // { url, duration }
  const [staticBars, setStaticBars] = useState([])
  const [transcriptOpen, setTranscriptOpen] = useState(false)

  const recorderRef = useRef(null)
  const streamRef = useRef(null)
  const chunksRef = useRef([])
  const audioCtxRef = useRef(null)
  const rafRef = useRef(null)
  const timerRef = useRef(null)
  const startTimeRef = useRef(0)
  const elapsedRef = useRef(0)
  const barsRefs = useRef([])
  const audioRef = useRef(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)

  // Revoke the preview blob URL when unmounting so recorded audio does not
  // linger in browser memory (defense against data leaks).
  const recordingUrlRef = useRef(null)
  useEffect(() => {
    recordingUrlRef.current = recording?.url || null
  }, [recording])
  useEffect(() => {
    const url = recordingUrlRef.current
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
    // unmount only - empty deps intentionally
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const cleanupStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {})
      audioCtxRef.current = null
    }
  }, [])

  const stopTimerAndRaf = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
  }, [])

  useEffect(() => {
    return () => {
      stopTimerAndRaf()
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        recorderRef.current.stop()
      }
      cleanupStream()
    }
  }, [stopTimerAndRaf, cleanupStream])

  async function buildStaticWaveform(blob) {
    try {
      const buffer = await blob.arrayBuffer()
      const ctx = new AudioContext()
      const decoded = await ctx.decodeAudioData(buffer)
      const channel = decoded.getChannelData(0)
      const block = Math.floor(channel.length / WAVE_BARS) || 1
      const bars = []
      for (let i = 0; i < WAVE_BARS; i++) {
        let sum = 0
        for (let j = i * block; j < Math.min((i + 1) * block, channel.length); j++) {
          sum += Math.abs(channel[j])
        }
        bars.push(Math.max(0.06, Math.min(1, (sum / block) * 4)))
      }
      setStaticBars(bars)
      ctx.close().catch(() => {})
    } catch {
      const fallback = []
      for (let i = 0; i < WAVE_BARS; i++) fallback.push(0.4 + ((i * 7) % 50) / 100)
      setStaticBars(fallback)
    }
  }

  async function startRecording() {
    setRecordError('')
    setElapsed(0)
    elapsedRef.current = 0
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const mime = pickMimeType()
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      recorderRef.current = rec
      chunksRef.current = []
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
        const url = URL.createObjectURL(blob)
        setRecording({ url, duration: elapsedRef.current })
        buildStaticWaveform(blob)
        onRecordingComplete?.(blob, elapsedRef.current)
      }
      rec.start()
      setStatus('recording')
      startTimeRef.current = Date.now()

      try {
        const ctx = new AudioContext()
        audioCtxRef.current = ctx
        const source = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 256
        source.connect(analyser)
        const data = new Uint8Array(analyser.fftSize)
        const tick = () => {
          analyser.getByteTimeDomainData(data)
          let sum = 0
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] - 128) / 128
            sum += v * v
          }
          const amp = Math.min(1, Math.sqrt(sum / data.length) * 3)
          barsRefs.current.forEach((bar) => {
            if (bar) bar.style.height = `${Math.max(4, Math.min(100, amp * 100))}%`
          })
          rafRef.current = requestAnimationFrame(tick)
        }
        tick()
      } catch {
        /* waveform optional */
      }

      timerRef.current = setInterval(() => {
        elapsedRef.current = Math.min(MAX_RECORD_SECONDS, (Date.now() - startTimeRef.current) / 1000)
        setElapsed(elapsedRef.current)
        if (elapsedRef.current >= MAX_RECORD_SECONDS) stopRecording()
      }, 250)
    } catch {
      setRecordError('Microphone access is needed to record. You can still upload an audio file instead.')
    }
  }

  function stopRecording() {
    stopTimerAndRaf()
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop()
    }
    cleanupStream()
    setStatus('stopped')
  }

  function pauseRecording() {
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.pause()
      setStatus('paused')
      stopTimerAndRaf()
      barsRefs.current.forEach((bar) => { if (bar) bar.style.height = '8%' })
    }
  }

  function resumeRecording() {
    if (recorderRef.current?.state === 'paused') {
      recorderRef.current.resume()
      startTimeRef.current = Date.now() - elapsedRef.current * 1000
      setStatus('recording')
      timerRef.current = setInterval(() => {
        elapsedRef.current = Math.min(MAX_RECORD_SECONDS, (Date.now() - startTimeRef.current) / 1000)
        setElapsed(elapsedRef.current)
        if (elapsedRef.current >= MAX_RECORD_SECONDS) stopRecording()
      }, 250)
    }
  }

  function reRecord() {
    stopRecording()
    if (recording?.url) URL.revokeObjectURL(recording.url)
    setRecording(null)
    setStaticBars([])
    setCurrentTime(0)
    onRecordingComplete?.(null)
    setStatus('idle')
  }

  function togglePlay() {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) {
      audio.play()
    } else {
      audio.pause()
    }
  }

  const isActive = status === 'recording'
  const isPaused = status === 'paused'

  return (
    <div className="voice-recorder">
      {recordError && (
        <p className="auth-banner error" role="alert">{recordError}</p>
      )}

      {status === 'stopped' && recording && (
        <audio
          ref={audioRef}
          src={recording.url}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          onLoadedMetadata={() => setCurrentTime(0)}
        />
      )}

      <div className="rec-center">
        <button
          type="button"
          className={`rec-button ${isActive ? 'recording' : ''} ${isPaused ? 'paused' : ''}`}
          aria-label={isActive ? 'Stop recording' : 'Start recording'}
          aria-pressed={isActive || isPaused}
          disabled={status === 'stopped'}
          onClick={isActive ? stopRecording : isPaused ? resumeRecording : startRecording}
        >
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="9" y="2" width="6" height="12" rx="3" />
            <path d="M5 10v2a7 7 0 0 0 14 0v-2" />
            <path d="M12 19v3" />
          </svg>
        </button>

        {status === 'stopped' && recording ? null : (
          <div className="waveform" aria-hidden="true">
            {Array.from({ length: WAVE_BARS }).map((_, i) => (
              <span
                key={i}
                className="wave-bar"
                ref={(el) => { barsRefs.current[i] = el }}
              />
            ))}
          </div>
        )}

        {status !== 'idle' && status !== 'stopped' && (
          <span className="rec-timer">{formatTime(elapsed)}</span>
        )}
        {status === 'stopped' && recording && (
          <span className="rec-timer">Recorded {formatTime(recording.duration)}</span>
        )}

        {(isActive || isPaused) && (
          <div className="rec-actions">
            {isActive ? (
              <button type="button" className="btn-ghost btn-pill rec-pause" onClick={pauseRecording}>
                Pause
              </button>
            ) : (
              <button type="button" className="btn-ghost btn-pill rec-pause" onClick={resumeRecording}>
                Resume
              </button>
            )}
            <button type="button" className="btn-ghost btn-pill" onClick={stopRecording}>
              Stop
            </button>
          </div>
        )}
      </div>

      {status === 'stopped' && recording && (
        <div className="playback">
          <div className="static-waveform" aria-hidden="true">
            {staticBars.map((h, i) => (
              <span key={i} className="wave-bar static" style={{ height: `${h * 100}%` }} />
            ))}
          </div>
          <div className="playback-controls">
            <button
              type="button"
              className="play-btn"
              aria-label={playing ? 'Pause playback' : 'Play recording'}
              onClick={togglePlay}
            >
              {playing ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" /></svg>
              )}
            </button>
            <input
              type="range"
              className="scrubber"
              min="0"
              max={recording.duration || 0}
              step="0.05"
              value={Math.min(currentTime, recording.duration || 0)}
              onChange={(e) => {
                if (audioRef.current) audioRef.current.currentTime = Number(e.target.value)
                setCurrentTime(Number(e.target.value))
              }}
              aria-label="Playback position"
            />
            <span className="playback-time">
              {formatTime(currentTime)} / {formatTime(recording.duration)}
            </span>
          </div>
          <button type="button" className="btn-ghost btn-pill rec-rerecord" onClick={reRecord}>
            Re-record
          </button>
        </div>
      )}

      {status === 'stopped' && recording && (
        <div className="transcript-block">
          <button
            type="button"
            className="transcript-toggle"
            onClick={() => setTranscriptOpen((o) => !o)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
            </svg>
            AI transcript (auto-generated, editable)
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={transcriptOpen ? 'chev open' : 'chev'} aria-hidden="true">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          {transcriptOpen && (
            <textarea
              rows={4}
              className="transcript-input"
              placeholder="Transcription will be auto-generated here once available. You can type or edit the transcript now — it makes this memory searchable."
              value={transcript || ''}
              onChange={(e) => onTranscriptChange?.(e.target.value)}
            />
          )}
        </div>
      )}
    </div>
  )
}

export default VoiceRecorder