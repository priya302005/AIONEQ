const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000'

// NOTE: files are intentionally NOT reachable via a raw storage URL anymore.
// The only file URL the app may construct is the signed /api/files/:token URL
// returned by GET /api/memories/:id/signed-url (see hooks/useSignedFileUrl.js).

export default API_URL