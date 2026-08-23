import cors from 'cors'
import express from 'express'
import multer from 'multer'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const dataRoot = path.join(root, '..', 'data', 'clients')
const app = express()

app.use(cors())
app.use(express.json({ limit: '2mb' }))
app.use('/files', express.static(dataRoot))

const safeSlug = (value = 'meu-negocio') => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'meu-negocio'
const clientDirectory = (slug) => path.join(dataRoot, safeSlug(slug))
const storage = multer.diskStorage({
  destination: async (request, file, callback) => {
    const folder = clientDirectory(request.params.slug)
    await fs.mkdir(folder, { recursive: true })
    callback(null, folder)
  },
  filename: (request, file, callback) => callback(null, `${Date.now()}-${safeSlug(path.parse(file.originalname).name)}${path.extname(file.originalname).toLowerCase()}`),
})
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024, files: 10 } })

app.get('/api/health', (request, response) => response.json({ ok: true }))
app.get('/api/clients/:slug', async (request, response) => {
  try {
    const content = await fs.readFile(path.join(clientDirectory(request.params.slug), 'data.json'), 'utf8')
    response.json(JSON.parse(content))
  } catch { response.status(404).json({ error: 'Cliente não encontrado' }) }
})
app.post('/api/clients/:slug', async (request, response) => {
  const slug = safeSlug(request.params.slug)
  const folder = clientDirectory(slug)
  await fs.mkdir(folder, { recursive: true })
  await fs.writeFile(path.join(folder, 'data.json'), JSON.stringify({ ...request.body, slug, updatedAt: new Date().toISOString() }, null, 2))
  response.json({ ok: true, slug })
})
app.post('/api/clients/:slug/upload', upload.array('photos', 10), (request, response) => {
  const files = (request.files || []).map((file) => ({ name: file.filename, path: `/files/${safeSlug(request.params.slug)}/${file.filename}` }))
  response.json({ ok: true, files })
})

const port = process.env.PORT || 4000
app.listen(port, () => console.log(`Portal Micro API: http://localhost:${port}`))
