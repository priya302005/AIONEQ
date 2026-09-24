export function formatRelativeTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  const diff = Date.now() - date.getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`

  const days = Math.floor(hours / 24)
  if (days <= 7) return `${days} day${days === 1 ? '' : 's'} ago`

  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function formatFullDate(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function formatDuration(seconds) {
  const n = Number(seconds)
  if (!Number.isFinite(n) || n <= 0) return null
  const mins = Math.floor(n / 60)
  const secs = Math.floor(n % 60)
  return `${mins}:${String(secs).padStart(2, '0')}`
}

export function formatMemoryDate(value) {
  const d = value ? new Date(value) : null
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : ''
}