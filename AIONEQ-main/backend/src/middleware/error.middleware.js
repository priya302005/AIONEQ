export function notFound(req, res) {
  res.status(404).json({ message: 'Route not found.' })
}

export function errorHandler(err, req, res, next) {
  console.error('[ERROR]', err)

  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ message: 'File is too large. Maximum size is 25MB.' })
  }

  const status = err.status || 500
  res.status(status).json({ message: err.message || 'Internal server error.' })
}