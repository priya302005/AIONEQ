import express from 'express'
import cors from 'cors'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import authRoutes from './routes/auth.routes.js'
import memoryRoutes from './routes/memory.routes.js'
import queryRoutes from './routes/query.routes.js'
import { uploadsDir } from './middleware/upload.middleware.js'
import { notFound, errorHandler } from './middleware/error.middleware.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()

app.use(cors())
app.use(express.json())

app.get('/api/health', (req, res) => res.json({ status: 'ok' }))

app.use('/api/auth', authRoutes)
app.use('/api/memories', memoryRoutes)
app.use('/api/query', queryRoutes)
app.use('/uploads', express.static(uploadsDir))

app.use(notFound)
app.use(errorHandler)

export default app