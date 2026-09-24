const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000'

export function absoluteFileUrl(fileUrl) {
  if (!fileUrl) return ''
  return fileUrl.startsWith('http') ? fileUrl : `${API_URL}${fileUrl}`
}

export default API_URL