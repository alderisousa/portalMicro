import cors from 'cors'
import express from 'express'
import multer from 'multer'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getApps, initializeApp, cert } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'

const root = path.dirname(fileURLToPath(import.meta.url))
const persistentRoot = process.env.DATA_ROOT ? path.resolve(process.env.DATA_ROOT) : path.join(root, '..', 'data')
const dataRoot = path.join(persistentRoot, 'clients')
const accountRoot = path.join(persistentRoot, 'accounts')
const app = express()

const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON) : null
const adminApp = serviceAccount ? (getApps().length ? getApps()[0] : initializeApp({ credential: cert(serviceAccount) })) : null
const firebaseAuth = adminApp ? getAuth(adminApp) : null

app.use(cors())
app.use(express.json({ limit: '2mb' }))
app.use('/files', express.static(dataRoot))

const safeSlug = (value = 'meu-negocio') => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'meu-negocio'
const clientDirectory = (slug) => path.join(dataRoot, safeSlug(slug))
const formatAddress = (business) => [business.street, business.number && `Nº ${business.number}`, business.complement, business.neighborhood, business.city, business.cep && `CEP: ${business.cep}`].filter(Boolean).join(', ') || business.address || ''
const storage = multer.diskStorage({
  destination: async (request, file, callback) => {
    const folder = clientDirectory(request.params.slug)
    await fs.mkdir(folder, { recursive: true })
    callback(null, folder)
  },
  filename: (request, file, callback) => callback(null, `${Date.now()}-${safeSlug(path.parse(file.originalname).name)}${path.extname(file.originalname).toLowerCase()}`),
})
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024, files: 10 } })
const requireAuth = async (request, response, next) => {
  if (!firebaseAuth) return response.status(503).json({ error: 'Autenticação do servidor não configurada' })
  const token = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : ''
  try { request.user = await firebaseAuth.verifyIdToken(token); next() } catch { response.status(401).json({ error: 'Token inválido ou ausente' }) }
}

app.get('/api/health', (request, response) => response.json({ ok: true }))
app.get('/api/clients', async (request, response) => {
  try {
    const entries = await fs.readdir(dataRoot, { withFileTypes: true })
    const clients = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      try {
        const content = await fs.readFile(path.join(dataRoot, entry.name, 'data.json'), 'utf8')
        const business = JSON.parse(content)
        return business.published ? { slug: entry.name, name: business.name || 'Negócio', area: business.area || '', logo: business.logo || '' } : null
      } catch { return null }
    }))
    response.json(clients.filter(Boolean))
  } catch { response.json([]) }
})
app.get('/api/account/business', requireAuth, async (request, response) => {
  try {
    const content = await fs.readFile(path.join(accountRoot, `${safeSlug(request.user.uid)}.json`), 'utf8')
    const business = JSON.parse(content)
    response.json({ ...business, address: formatAddress(business) })
  } catch { response.status(404).json({ error: 'Cadastro não encontrado' }) }
})
app.post('/api/account/business', requireAuth, async (request, response) => {
  const business = request.body
  const slug = safeSlug(business.name || business.area)
  const folder = clientDirectory(slug)
  await fs.mkdir(folder, { recursive: true })
  await fs.mkdir(accountRoot, { recursive: true })
  const saved = { ...business, address: formatAddress(business), slug, ownerId: request.user.uid, updatedAt: new Date().toISOString() }
  await fs.writeFile(path.join(folder, 'data.json'), JSON.stringify(saved, null, 2))
  await fs.writeFile(path.join(accountRoot, `${safeSlug(request.user.uid)}.json`), JSON.stringify(saved, null, 2))
  response.json({ ok: true, slug })
})
app.get('/api/clients/:slug', async (request, response) => {
  try {
    const content = await fs.readFile(path.join(clientDirectory(request.params.slug), 'data.json'), 'utf8')
    const business = JSON.parse(content)
    response.json({ ...business, address: formatAddress(business) })
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
app.post('/api/clients/:slug/logo', upload.single('logo'), (request, response) => {
  if (!request.file) return response.status(400).json({ error: 'Logo não enviada' })
  response.json({ ok: true, path: `/files/${safeSlug(request.params.slug)}/${request.file.filename}` })
})

const port = process.env.PORT || 4000
app.listen(port, () => console.log(`Portal Micro API: http://localhost:${port}`))
