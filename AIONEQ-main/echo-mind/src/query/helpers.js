import { getMemoryType } from '../memoryTypes.jsx'

export function timeAgo(iso) {
  if (!iso) return ''
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (diff < 60) return 'just now'
  const min = Math.floor(diff / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function memoryDateLabel(value) {
  const d = value ? new Date(value) : null
  if (!d || Number.isNaN(d.getTime())) return ''
  const now = new Date()
  return d.getFullYear() === now.getFullYear()
    ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}

export function memoryTypeMeta(type) {
  const config = getMemoryType(type)
  return {
    title: config?.title || type,
    Icon: config?.Icon || null,
  }
}