import {
  ArrowLeft,
  ArrowRight,
  Check,
  EyeOff,
  Globe,
  Save,
  Sparkles,
} from 'lucide-react'
import { ChangeEvent, useEffect, useRef, useState } from 'react'
import { Brand } from './components/Brand'
import { BusinessTemplateEssential } from './components/BusinessTemplateEssential'
import { BusinessTemplateFeatured } from './components/BusinessTemplateFeatured'
import { Header } from './components/Header'
import { WizardQuestion } from './components/WizardQuestion'
import { selectedCity, stepNames } from './constants/portal'
import { supabase } from './lib/supabase'
import { Admin } from './pages/Admin'
import { BusinessTemplateSelection } from './pages/BusinessTemplateSelection'
import { Home } from './pages/Home'
import { sendNotification } from './services/notifications'
import type { Business, BusinessTemplateKey, ClientSummary } from './types/business'
import { formatAddress, formatCep } from './utils/formatters'
import {
  BusinessMediaValidationError,
  getBusinessMediaUrl,
  uploadBusinessMedia,
  validateBusinessImage,
} from './utils/storage'

const storageKey = 'portalmicro-business'
const sessionKey = 'portalmicro-session'
const homeSeoTitle = 'PortalMicro | Negócios e serviços da sua região'
const homeSeoDescription = 'Encontre negócios, profissionais e serviços da sua região ou crie uma página profissional para divulgar seu negócio no PortalMicro.'
const homeCanonicalUrl = 'https://portal-micro.vercel.app/'

const initialRequestedSite =
  new URLSearchParams(window.location.search).get('site')

const emptyBusiness: Business = {
  area: '',
  businessModel: 'services',
  name: '',
  logo: '',
  location: '',
  address: '',
  cep: '',
  street: '',
  neighborhood: '',
  city: '',
  number: '',
  complement: '',
  showAddress: true,
  story: '',
  photos: [],
  whatsapp: '',
  email: '',
  published: false,
  isSuspended: false,
  isOwnerPaused: false,
  templateKey: null,
  publicUrl: '',
  step: 0,
}

type BusinessRecord = {
  id: string
  slug: string | null
  owner_id: string
  name: string | null
  category: string | null
  business_model?: string | null
  story: string | null
  service_type: string | null
  logo_path: string | null
  cep: string | null
  street: string | null
  number: string | null
  complement: string | null
  neighborhood: string | null
  city: string | null
  show_address: boolean | null
  contact_email: string | null
  whatsapp: string | null
  status: string
  wizard_step?: number | null
  is_suspended?: boolean | null
  is_owner_paused?: boolean | null
  template_key?: string | null
}

type BusinessItemRecord = {
  id: string
  title: string | null
  image_path: string | null
  description: string | null
}

const publicMediaUrl = getBusinessMediaUrl

const createSlug = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

const mapBusinessRecord = (
  data: BusinessRecord,
  items: BusinessItemRecord[]
): Partial<Business> => {
  const locationByServiceType: Record<
    string,
    Business['location']
  > = {
    physical: 'fisico',
    online: 'online',
    both: 'ambos',
  }

  const mappedBusiness: Partial<Business> = {
    id: data.id,
    slug: data.slug ?? undefined,
    name: data.name ?? '',
    area: data.category ?? '',
    businessModel:
      data.business_model === 'products' || data.business_model === 'both'
        ? data.business_model
        : 'services',
    logo: data.logo_path ?? '',
    location: data.service_type
      ? locationByServiceType[data.service_type] ?? ''
      : '',
    address: '',
    cep: data.cep ?? '',
    street: data.street ?? '',
    neighborhood: data.neighborhood ?? '',
    city: data.city ?? '',
    number: data.number ?? '',
    complement: data.complement ?? '',
    showAddress: data.show_address ?? true,
    story: data.story ?? '',
    photos: items
      .filter((item) => Boolean(item.image_path))
      .slice(0, 5)
      .map((item) => ({
        id: item.id,
        url: item.image_path ?? '',
        title: item.title ?? '',
        description: item.description ?? '',
      })),
    whatsapp: data.whatsapp ?? '',
    email: data.contact_email ?? '',
    ownerId: data.owner_id,
    published: data.status === 'published',
    step: data.status === 'published'
      ? 6
      : Math.min(Math.max(data.wizard_step ?? 0, 0), 6),
    isSuspended: data.is_suspended ?? false,
    isOwnerPaused: data.is_owner_paused ?? false,
    templateKey:
      data.template_key === 'featured' || data.template_key === 'essential'
        ? data.template_key
        : null,
  }

  mappedBusiness.address = formatAddress({
    ...emptyBusiness,
    ...mappedBusiness,
  })

  return mappedBusiness
}

function App() {
  const [requestedSite, setRequestedSite] = useState(initialRequestedSite)

  const [view, setView] = useState<
    'home' | 'login' | 'dashboard' | 'wizard' | 'preview' | 'admin' | 'template'
  >(() => (initialRequestedSite ? 'preview' : 'home'))

  const [menuOpen, setMenuOpen] = useState(false)

  const [signedIn, setSignedIn] = useState(
    () => localStorage.getItem(sessionKey) === 'demo-user'
  )

  const [accountName, setAccountName] = useState('empreendedor')
  const [accountEmail, setAccountEmail] = useState('')
  const [accountAvatarUrl, setAccountAvatarUrl] = useState('')
  const [authMessage, setAuthMessage] = useState('')
  const [currentUserId, setCurrentUserId] = useState('')
  const [isAdmin, setIsAdmin] = useState(false)
  const [saveMessage, setSaveMessage] = useState('')
  const [savingBusiness, setSavingBusiness] = useState(false)
  const [savingTemplate, setSavingTemplate] = useState(false)
  const [templateMessage, setTemplateMessage] = useState('')
  const [showTakeOfflineConfirmation, setShowTakeOfflineConfirmation] = useState(false)

  const [clients, setClients] = useState<ClientSummary[]>([])

  const [business, setBusiness] = useState<Business>(() => {
    if (requestedSite) {
      return emptyBusiness
    }

    const saved = JSON.parse(
      localStorage.getItem(storageKey) || 'null'
    ) || {}

    return {
      ...emptyBusiness,
      ...saved,
      cep: saved.cep || '',
      email: saved.email || '',
      photos: Array.isArray(saved.photos)
        ? saved.photos.slice(0, 5)
        : [],
    }
  })

  useEffect(() => {
    const setMetaContent = (selector: string, content: string) => {
      document.querySelector<HTMLMetaElement>(selector)?.setAttribute('content', content)
    }

    const existingCanonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')

    if (requestedSite) {
      document.title = 'PortalMicro | Página pública de negócio'
      setMetaContent('meta[name="description"]', 'Conheça este negócio no PortalMicro.')
      setMetaContent('meta[name="robots"]', 'noindex, follow')
      setMetaContent('meta[property="og:title"]', 'Página pública de negócio | PortalMicro')
      setMetaContent('meta[property="og:description"]', 'Conheça este negócio no PortalMicro.')
      setMetaContent('meta[property="og:url"]', window.location.href)
      setMetaContent('meta[name="twitter:title"]', 'Página pública de negócio | PortalMicro')
      setMetaContent('meta[name="twitter:description"]', 'Conheça este negócio no PortalMicro.')
      existingCanonical?.remove()
      return
    }

    document.title = homeSeoTitle
    setMetaContent('meta[name="description"]', homeSeoDescription)
    setMetaContent('meta[name="robots"]', 'index, follow')
    setMetaContent('meta[property="og:title"]', homeSeoTitle)
    setMetaContent('meta[property="og:description"]', homeSeoDescription)
    setMetaContent('meta[property="og:url"]', homeCanonicalUrl)
    setMetaContent('meta[name="twitter:title"]', homeSeoTitle)
    setMetaContent('meta[name="twitter:description"]', homeSeoDescription)

    if (!existingCanonical) {
      const canonical = document.createElement('link')
      canonical.rel = 'canonical'
      canonical.href = homeCanonicalUrl
      document.head.appendChild(canonical)
    } else {
      existingCanonical.href = homeCanonicalUrl
    }
  }, [requestedSite])

  const loadedOwnedBusinessUserId = useRef('')
  const authenticatedUserId = useRef('')
  const furthestWizardStep = useRef(business.step)
  const savingBusinessRef = useRef(false)
  const pendingLogoFile = useRef<File | null>(null)
  const welcomeNotificationUsers = useRef(new Set<string>())

  const triggerWelcomeNotification = (userId: string) => {
    if (welcomeNotificationUsers.current.has(userId)) return
    welcomeNotificationUsers.current.add(userId)
    void sendNotification('welcome')
  }

  const loadOwnedBusiness = async (userId: string) => {
    if (requestedSite || loadedOwnedBusinessUserId.current === userId) {
      return
    }

    loadedOwnedBusinessUserId.current = userId

    const { data: businesses, error } = await supabase
      .from('businesses')
      .select(
        'id, owner_id, slug, name, category, business_model, story, service_type, logo_path, cep, street, number, complement, neighborhood, city, show_address, contact_email, whatsapp, status, wizard_step, is_suspended, is_owner_paused, template_key'
      )
      .eq('owner_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)

    if (error) {
      loadedOwnedBusinessUserId.current = ''
      console.error('Falha ao carregar o negócio do usuário:', error)
      return
    }

    const ownedBusiness = businesses?.[0]

    if (!ownedBusiness) return

    const { data: items, error: itemsError } = await supabase
      .from('business_items')
      .select('id, title, image_path, description')
      .eq('business_id', ownedBusiness.id)
      .order('position', { ascending: true })

    if (itemsError) {
      loadedOwnedBusinessUserId.current = ''
      console.error(
        'Falha ao carregar as fotos do negócio do usuário:',
        itemsError
      )
      return
    }

    const mappedBusiness = mapBusinessRecord(
      ownedBusiness,
      items ?? []
    )

    furthestWizardStep.current = mappedBusiness.step ?? 0

    setBusiness((current) => ({
      ...current,
      ...mappedBusiness,
      publicUrl: current.publicUrl,
    }))
  }

  const loadUserRole = async (userId: string) => {
    const { data, error } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', userId)
      .maybeSingle()

    if (authenticatedUserId.current !== userId) return

    if (error) {
      console.error('Falha ao carregar a role do usuário:', error)
    }

    setIsAdmin(!error && data?.role === 'admin')
  }

  const saveBusiness = async (wizardStep = furthestWizardStep.current) => {
    if (!currentUserId) return 'local-only' as const

    if (business.story.length > 1000) {
      setSaveMessage(
        'A história do negócio deve ter no máximo 1000 caracteres.'
      )
      return 'error' as const
    }

    if (business.step === 3 && business.story.trim().length < 30) {
      setSaveMessage(
        'Conte um pouco mais sobre seu negócio. Use pelo menos 30 caracteres.'
      )
      return 'error' as const
    }

    if (business.step === 2 && !business.location) {
      setSaveMessage('Selecione como você atende seus clientes.')
      return 'error' as const
    }

    if (business.area.length > 150) {
      setSaveMessage(
        'A área de atuação deve ter no máximo 150 caracteres.'
      )
      return 'error' as const
    }

    const businessName = business.name.trim()

    if (!businessName) {
      if (!business.id) return 'local-only' as const

      setSaveMessage('Informe o nome do seu negócio para continuar.')
      return 'error' as const
    }

    if (savingBusinessRef.current) return 'error' as const

    savingBusinessRef.current = true
    setSavingBusiness(true)
    setSaveMessage('Salvando...')

    const serviceTypeByLocation: Record<
      Business['location'],
      'physical' | 'online' | 'both' | null
    > = {
      fisico: 'physical',
      online: 'online',
      ambos: 'both',
      '': null,
    }

    const payload = {
      owner_id: currentUserId,
      category: business.area || null,
      business_model: business.businessModel,
      name: businessName,
      story: business.story || null,
      service_type: serviceTypeByLocation[business.location],
      ...(business.logo.startsWith('blob:')
        ? {}
        : { logo_path: business.logo || null }),
      cep: business.cep || null,
      street: business.street || null,
      number: business.number || null,
      complement: business.complement || null,
      neighborhood: business.neighborhood || null,
      city: business.city || null,
      show_address: business.showAddress,
      contact_email: business.email || null,
      whatsapp: business.whatsapp || null,
      wizard_step: wizardStep,
    }

    const operation = business.id ? 'UPDATE' : 'INSERT'
    const payloadFields = business.id
      ? Object.keys(payload)
      : [...Object.keys(payload), 'slug', 'status']

    try {
      let savedBusiness: {
        id: string
        slug: string | null
        status: string
      }

      if (business.id) {
        const { data, error } = await supabase
          .from('businesses')
          .update(payload)
          .eq('id', business.id)
          .eq('owner_id', currentUserId)
          .select('id, slug, status')
          .single()

        if (error) throw error
        savedBusiness = data
      } else {
        const baseSlug = createSlug(
          businessName
        ) || 'meu-negocio'

        const insertBusiness = async (slug: string) =>
          supabase
            .from('businesses')
            .insert({
              ...payload,
              slug,
              status: 'draft',
            })
            .select('id, slug, status')
            .single()

        let result = await insertBusiness(baseSlug)

        if (result.error?.code === '23505') {
          result = await insertBusiness(
            `${baseSlug}-${crypto.randomUUID().slice(0, 8)}`
          )
        }

        if (result.error) throw result.error
        savedBusiness = result.data
      }

      setBusiness((current) => ({
        ...current,
        id: savedBusiness.id,
        slug: savedBusiness.slug ?? current.slug,
        ownerId: currentUserId,
        published: savedBusiness.status === 'published',
      }))
      setSaveMessage('Dados salvos com sucesso.')
      return {
        status: 'saved' as const,
        businessId: savedBusiness.id,
      }
    } catch (error) {
      const supabaseError = error as {
        code?: string
        message?: string
        details?: string
        hint?: string
      }

      console.error('Falha ao salvar o negócio no Supabase.')
      console.error('Operação:', operation)
      console.error('Campos do payload:', payloadFields)
      console.error('Código Supabase:', supabaseError.code ?? 'não informado')
      console.error(
        'Mensagem Supabase:',
        supabaseError.message ?? 'não informada'
      )
      console.error(
        'Detalhes Supabase:',
        supabaseError.details ?? 'não informados'
      )
      console.error('Hint Supabase:', supabaseError.hint ?? 'não informado')
      setSaveMessage(
        'Não foi possível salvar agora. Seus dados continuam salvos neste navegador.'
      )
      return 'error' as const
    } finally {
      savingBusinessRef.current = false
      setSavingBusiness(false)
    }
  }

  const uploadLogo = async (file: File) => {
    try {
      validateBusinessImage(file)

      if (!currentUserId) return URL.createObjectURL(file)

      if (!business.id) {
        pendingLogoFile.current = file
        return URL.createObjectURL(file)
      }

      const path = await uploadBusinessMedia(
        file,
        currentUserId,
        business.id,
        'logo'
      )
      pendingLogoFile.current = null
      return path
    } catch (error) {
      if (error instanceof BusinessMediaValidationError) {
        setSaveMessage(error.message)
        throw error
      }

      console.error('Falha ao enviar logo para o Supabase Storage:', error)
      setSaveMessage(
        'Não foi possível enviar o logo agora. A prévia local será perdida ao recarregar a página.'
      )
      pendingLogoFile.current = file
      return URL.createObjectURL(file)
    }
  }

  const savePendingLogo = async (businessId: string) => {
    const file = pendingLogoFile.current

    if (!file) {
      if (business.logo.startsWith('blob:')) {
        setSaveMessage(
          'Selecione o logo novamente para concluir o upload.'
        )
        return false
      }

      return true
    }

    try {
      setSaveMessage('Salvando logo...')
      const path = await uploadBusinessMedia(
        file,
        currentUserId,
        businessId,
        'logo'
      )
      const { error } = await supabase
        .from('businesses')
        .update({ logo_path: path })
        .eq('id', businessId)
        .eq('owner_id', currentUserId)

      if (error) throw error

      pendingLogoFile.current = null
      setBusiness((current) => ({ ...current, logo: path }))
      setSaveMessage('Dados salvos com sucesso.')
      return true
    } catch (error) {
      console.error('Falha ao salvar logo no Supabase Storage:', error)
      setSaveMessage(
        'Não foi possível salvar o logo. A prévia local será perdida ao recarregar a página.'
      )
      return false
    }
  }

  const saveBusinessItems = async (businessId: string) => {
    if (business.photos.some((photo) => photo.url.startsWith('blob:'))) {
      setSaveMessage(
        'Uma ou mais fotos estão disponíveis somente neste navegador. Selecione-as novamente para concluir o upload.'
      )
      return false
    }

    savingBusinessRef.current = true
    setSavingBusiness(true)
    setSaveMessage('Salvando fotos...')

    try {
      const { data: existingItems, error: loadError } = await supabase
        .from('business_items')
        .select('id, image_path')
        .eq('business_id', businessId)

      if (loadError) throw loadError

      const syncedPhotos = business.photos.slice(0, 5)

      for (const [position, photo] of syncedPhotos.entries()) {
        if (photo.id) {
          const { error } = await supabase
            .from('business_items')
            .update({
              image_path: photo.url,
              title: photo.title || null,
              description: photo.description,
              position,
            })
            .eq('id', photo.id)
            .eq('business_id', businessId)
            .select('id')
            .single()

          if (error) throw error
          continue
        }

        const { data, error } = await supabase
          .from('business_items')
          .insert({
            business_id: businessId,
            image_path: photo.url,
            title: photo.title || null,
            description: photo.description,
            position,
          })
          .select('id')
          .single()

        if (error) throw error

        syncedPhotos[position] = {
          ...photo,
          id: data.id,
        }

        setBusiness((current) => ({
          ...current,
          photos: current.photos.map((currentPhoto, index) =>
            index === position && currentPhoto.url === photo.url
              ? { ...currentPhoto, id: data.id }
              : currentPhoto
          ),
        }))
      }

      const retainedIds = new Set(
        syncedPhotos.flatMap((photo) => photo.id ? [photo.id] : [])
      )
      const removedIds = (existingItems ?? [])
        .filter((item) => Boolean(item.image_path))
        .map((item) => item.id)
        .filter((id) => !retainedIds.has(id))

      if (removedIds.length) {
        const { error } = await supabase
          .from('business_items')
          .delete()
          .eq('business_id', businessId)
          .in('id', removedIds)

        if (error) throw error
      }

      setSaveMessage('Dados salvos com sucesso.')
      return true
    } catch (error) {
      const supabaseError = error as {
        code?: string
        message?: string
        details?: string
        hint?: string
      }

      console.error('Falha ao sincronizar fotos no Supabase.', {
        code: supabaseError.code,
        message: supabaseError.message,
        details: supabaseError.details,
        hint: supabaseError.hint,
      })
      setSaveMessage(
        'Não foi possível salvar as fotos agora. Seus dados continuam salvos neste navegador.'
      )
      return false
    } finally {
      savingBusinessRef.current = false
      setSavingBusiness(false)
    }
  }

  /*
   * ============================================================
   * SUPABASE AUTH
   * ============================================================
   *
   * Escuta alterações de sessão:
   *
   * - login Google
   * - logout
   * - restauração da sessão após atualizar a página
   */
  useEffect(() => {
    let mounted = true

    const loadSession = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!mounted) return

      const user = session?.user

      if (user) {
        authenticatedUserId.current = user.id
        setSignedIn(true)
        setCurrentUserId(user.id)

        setAccountName(
          user.user_metadata?.full_name ||
            user.user_metadata?.name ||
            user.email ||
            'empreendedor'
        )
        setAccountEmail(user.email || '')
        setAccountAvatarUrl(
          user.user_metadata?.avatar_url || user.user_metadata?.picture || ''
        )

        setBusiness((current) => ({
          ...current,
          email: current.email || user.email || '',
          ownerId: user.id,
        }))

        loadOwnedBusiness(user.id)
        void loadUserRole(user.id)
        triggerWelcomeNotification(user.id)
      } else {
        authenticatedUserId.current = ''
        setSignedIn(false)
        setCurrentUserId('')
        setIsAdmin(false)
        setAccountName('empreendedor')
        setAccountEmail('')
        setAccountAvatarUrl('')
      }
    }

    loadSession()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (!mounted) return

        const user = session?.user

        if (user) {
          authenticatedUserId.current = user.id
          setSignedIn(true)
          setCurrentUserId(user.id)

          setAccountName(
            user.user_metadata?.full_name ||
              user.user_metadata?.name ||
              user.email ||
              'empreendedor'
          )
          setAccountEmail(user.email || '')
          setAccountAvatarUrl(
            user.user_metadata?.avatar_url || user.user_metadata?.picture || ''
          )

          setBusiness((current) => ({
            ...current,
            email: current.email || user.email || '',
            ownerId: user.id,
          }))

          loadOwnedBusiness(user.id)
          void loadUserRole(user.id)
          triggerWelcomeNotification(user.id)
        } else {
          authenticatedUserId.current = ''
          setSignedIn(false)
          setCurrentUserId('')
          setIsAdmin(false)
          setAccountName('empreendedor')
          setAccountEmail('')
          setAccountAvatarUrl('')
          loadedOwnedBusinessUserId.current = ''
        }
      }
    )

    return () => {
      mounted = false
      authenticatedUserId.current = ''
      subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (view === 'admin' && (!signedIn || !isAdmin)) {
      setView(signedIn ? 'dashboard' : 'home')
    }
  }, [view, signedIn, isAdmin])

  /*
   * ============================================================
   * SALVAMENTO LOCAL
   * ============================================================
   *
   * Por enquanto mantemos o cadastro local.
   *
   * A próxima etapa será trocar isso pelo Supabase Database.
   */
  useEffect(() => {
    localStorage.setItem(
      storageKey,
      JSON.stringify(business)
    )
  }, [business])

  const loadPublicClients = async () => {
    const { data, error } = await supabase
      .from('businesses')
      .select('slug, name, category, logo_path')
      .eq('status', 'published')
      .eq('is_suspended', false)
      .eq('is_owner_paused', false)
      .not('slug', 'is', null)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('Falha ao carregar negócios públicos da Home:', error)
      setClients([])
      return false
    }

    setClients(
      (data ?? []).map((client) => ({
        slug: client.slug ?? '',
        name: client.name ?? '',
        area: client.category ?? '',
        logo: publicMediaUrl(client.logo_path),
      }))
    )
    return true
  }

  /*
   * ============================================================
   * CLIENTES PÚBLICOS
   * ============================================================
   */
  useEffect(() => {
    if (requestedSite || view !== 'home') return

    void loadPublicClients()
  }, [view, requestedSite])

  /*
   * ============================================================
   * SITE PÚBLICO
   * ============================================================
   */
  useEffect(() => {
    if (!requestedSite) return

    let mounted = true

    const loadPublicBusiness = async () => {
      const { data, error } = await supabase
        .from('businesses')
        .select(
          'id, owner_id, name, slug, category, business_model, story, service_type, logo_path, cep, street, number, complement, neighborhood, city, show_address, contact_email, whatsapp, status, is_suspended, is_owner_paused, template_key'
        )
        .eq('slug', requestedSite)
        .eq('status', 'published')
        .eq('is_suspended', false)
        .eq('is_owner_paused', false)
        .maybeSingle()

      if (error || !data) {
        console.warn(
          'Negócio público não encontrado ou indisponível:',
          error ?? requestedSite
        )
        return
      }

      const { data: items, error: itemsError } = await supabase
        .from('business_items')
        .select('id, title, image_path, description')
        .eq('business_id', data.id)
        .order('position', { ascending: true })

      if (itemsError) {
        console.warn('Falha ao carregar fotos do negócio:', itemsError)
      }

      if (!mounted) return

      const mappedBusiness = mapBusinessRecord(data, items ?? [])

      setBusiness((current) => ({
        ...current,
        ...mappedBusiness,
      }))
    }

    loadPublicBusiness()

    return () => {
      mounted = false
    }
  }, [])

  const update = (patch: Partial<Business>) =>
    setBusiness((current) => {
      const next = {
        ...current,
        ...patch,
      }

      return {
        ...next,
        address: formatAddress(next),
      }
    })

  const pageOwner = Boolean(
    requestedSite &&
      currentUserId &&
      business.ownerId === currentUserId
  )

  const wizardProgress = business.published
    ? 100
    : Math.round(
        (Math.min(business.step, business.templateKey ? 6 : 5) / 6) * 100
      )

  const leavePublicPreview = (targetView: 'dashboard' | 'template') => {
    window.history.pushState({}, '', window.location.origin)
    setRequestedSite(null)
    setView(targetView)
  }

  const start = () =>
    setView(
      signedIn &&
        (!requestedSite || pageOwner)
        ? 'dashboard'
        : 'login'
    )

  /*
   * ============================================================
   * LOGIN GOOGLE - SUPABASE
   * ============================================================
   */
  const signIn = async () => {
    setAuthMessage('')

    try {
      const { error } =
        await supabase.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo: window.location.origin,
          },
        })

      if (error) {
        throw error
      }
    } catch (error) {
      console.error('Erro no login Google:', error)

      setAuthMessage(
        error instanceof Error
          ? `Não foi possível concluir o login Google: ${error.message}`
          : 'Não foi possível concluir o login Google.'
      )
    }
  }

  /*
   * ============================================================
   * LOGOUT - SUPABASE
   * ============================================================
   */
  const logout = async () => {
    try {
      await supabase.auth.signOut()
    } catch (error) {
      console.error('Erro ao sair:', error)
    }

    localStorage.removeItem(sessionKey)

    authenticatedUserId.current = ''
    setSignedIn(false)
    setCurrentUserId('')
    setIsAdmin(false)
    setAccountName('empreendedor')
    setAccountEmail('')
    setAccountAvatarUrl('')
    setRequestedSite(null)
    setView('home')

    window.history.pushState(
      {},
      '',
      window.location.origin
    )
  }

  /*
   * ============================================================
   * MODO DEMONSTRAÇÃO
   * ============================================================
   */
  const demoSignIn = () => {
    localStorage.setItem(
      sessionKey,
      'demo-user'
    )

    setSignedIn(true)
    setView('dashboard')
  }

  const next = async () => {
    const nextStep = Math.min(business.step + 1, 6)

    if (business.step === 3 && business.story.trim().length < 30) {
      setSaveMessage(
        'Conte um pouco mais sobre seu negócio. Use pelo menos 30 caracteres.'
      )
      return
    }

    if (business.story.length > 1000) {
      setSaveMessage(
        'A história do negócio deve ter no máximo 1000 caracteres.'
      )
      return
    }

    if (business.step === 2 && !business.location) {
      setSaveMessage('Selecione como você atende seus clientes.')
      return
    }

    if (currentUserId) {
      const nextFurthestStep = Math.max(
        furthestWizardStep.current,
        nextStep
      )
      const saveResult = await saveBusiness()

      if (saveResult === 'error') return

      if (saveResult === 'local-only') {
        if (business.step !== 0) {
          setSaveMessage('Informe o nome do seu negócio para continuar.')
          return
        }

        setSaveMessage('Progresso salvo neste navegador.')
      }

      if (
        business.step === 1 &&
        typeof saveResult === 'object' &&
        !(await savePendingLogo(saveResult.businessId))
      ) {
        return
      }

      if (
        business.step === 4 &&
        typeof saveResult === 'object' &&
        !(await saveBusinessItems(saveResult.businessId))
      ) {
        return
      }

      if (
        typeof saveResult === 'object' &&
        nextFurthestStep > furthestWizardStep.current
      ) {
        const { error } = await supabase
          .from('businesses')
          .update({ wizard_step: nextFurthestStep })
          .eq('id', saveResult.businessId)
          .eq('owner_id', currentUserId)

        if (error) {
          console.error('Falha ao salvar o progresso do Wizard:', error)
          setSaveMessage(
            'Os dados foram salvos, mas não foi possível atualizar o progresso.'
          )
          return
        }
      }

      furthestWizardStep.current = nextFurthestStep
    }

    setSaveMessage('')

    update({
      step: nextStep,
    })

    setView('wizard')
  }

  const publish = async () => {
    if (!business.templateKey) {
      setSaveMessage('Escolha e confirme um modelo antes de publicar.')
      setTemplateMessage('Escolha e confirme um modelo antes de publicar.')
      update({ step: 6 })
      setView('wizard')
      return
    }

    if (!currentUserId) {
      if (localStorage.getItem(sessionKey) !== 'demo-user') {
        setSaveMessage('Entre na sua conta para publicar o negócio.')
        return
      }

      const demoSlug = createSlug(
        business.name || business.area || selectedCity
      ) || 'meu-negocio'
      const demoPublicUrl =
        `${window.location.origin}/?site=${demoSlug}`

      update({ published: true, isOwnerPaused: false, publicUrl: demoPublicUrl })
      window.history.pushState({}, '', demoPublicUrl)
      setView('preview')
      return
    }

    if (!business.id || !business.slug) {
      setSaveMessage(
        'Salve o cadastro do negócio antes de publicar.'
      )
      return
    }

    if (!business.name.trim()) {
      setSaveMessage('Informe o nome do seu negócio para publicar.')
      return
    }

    if (!business.location) {
      setSaveMessage('Selecione como você atende seus clientes.')
      return
    }

    if (business.story.trim().length < 30) {
      setSaveMessage(
        'Conte um pouco mais sobre seu negócio. Use pelo menos 30 caracteres.'
      )
      return
    }

    if (business.area.length > 150 || business.story.length > 1000) {
      setSaveMessage(
        'Revise os limites de tamanho dos campos antes de publicar.'
      )
      return
    }

    const saveResult = await saveBusiness()
    if (typeof saveResult !== 'object') return

    if (!(await savePendingLogo(saveResult.businessId))) return
    if (!(await saveBusinessItems(saveResult.businessId))) return

    savingBusinessRef.current = true
    setSavingBusiness(true)
    setSaveMessage('Publicando...')

    try {
      const { data, error } = await supabase
        .from('businesses')
        .update({ status: 'published', is_owner_paused: false })
        .eq('id', saveResult.businessId)
        .eq('owner_id', currentUserId)
        .select('id, slug, status, is_suspended, is_owner_paused')
        .single()

      if (error) throw error

      const publishedSlug = data.slug ?? business.slug
      const publicUrl =
        `${window.location.origin}/?site=${publishedSlug}`

      setBusiness((current) => ({
        ...current,
        id: data.id,
        slug: data.slug ?? current.slug,
        published: data.status === 'published',
        isSuspended: data.is_suspended,
        isOwnerPaused: data.is_owner_paused,
        publicUrl,
      }))
      furthestWizardStep.current = 6
      await loadPublicClients()
      setSaveMessage('Negócio publicado com sucesso.')
      void sendNotification('business_published', data.id)
      window.history.pushState({}, '', publicUrl)
      setView('preview')
    } catch (error) {
      const supabaseError = error as {
        code?: string
        message?: string
        details?: string
        hint?: string
      }

      console.error('Falha ao publicar o negócio no Supabase.', {
        code: supabaseError.code,
        message: supabaseError.message,
        details: supabaseError.details,
        hint: supabaseError.hint,
      })
      setSaveMessage(
        'Não foi possível publicar o negócio. O cadastro continua como rascunho.'
      )
    } finally {
      savingBusinessRef.current = false
      setSavingBusiness(false)
    }
  }

  const updatePublicSite = async () => {
    if (!currentUserId) {
      if (localStorage.getItem(sessionKey) === 'demo-user') {
        setSaveMessage('Site atualizado no modo demonstração.')
      }
      return
    }

    const saveResult = await saveBusiness()
    if (typeof saveResult !== 'object') return
    if (!(await savePendingLogo(saveResult.businessId))) return
    if (!(await saveBusinessItems(saveResult.businessId))) return

    await loadPublicClients()
    setSaveMessage('Site público atualizado com sucesso.')
  }

  const saveTemplate = async (templateKey: BusinessTemplateKey) => {
    if (savingTemplate) return

    setTemplateMessage('')

    if (localStorage.getItem(sessionKey) === 'demo-user') {
      update({ templateKey })
      setTemplateMessage('Modelo alterado no modo demonstração.')
      return
    }

    if (!currentUserId || !business.id) {
      setTemplateMessage('Conclua o cadastro do negócio antes de escolher um modelo.')
      return
    }

    setSavingTemplate(true)
    setTemplateMessage('Salvando modelo...')

    try {
      const { data, error } = await supabase
        .from('businesses')
        .update({ template_key: templateKey })
        .eq('id', business.id)
        .eq('owner_id', currentUserId)
        .select('template_key')
        .single()

      if (error) throw error

      update({ templateKey: data.template_key === 'featured' ? 'featured' : 'essential' })
      setTemplateMessage('Modelo da página atualizado com sucesso.')
    } catch (error) {
      console.error('Falha ao salvar modelo da página:', error)
      setTemplateMessage('Não foi possível salvar o modelo. Tente novamente.')
    } finally {
      setSavingTemplate(false)
    }
  }

  const setSiteOwnerPaused = async (isOwnerPaused: boolean) => {
    if (localStorage.getItem(sessionKey) === 'demo-user') {
      update({ isOwnerPaused })
      setSaveMessage(
        isOwnerPaused
          ? 'Seu site foi retirado do ar.'
          : 'Seu site foi publicado novamente.'
      )
      return
    }

    if (!currentUserId || !business.id) {
      setSaveMessage('Não foi possível alterar a publicação do site agora.')
      return
    }

    savingBusinessRef.current = true
    setSavingBusiness(true)
    setSaveMessage(isOwnerPaused ? 'Tirando site do ar...' : 'Publicando novamente...')

    try {
      const { data, error } = await supabase
        .from('businesses')
        .update({ is_owner_paused: isOwnerPaused })
        .eq('id', business.id)
        .eq('owner_id', currentUserId)
        .select('id, status, is_owner_paused, is_suspended')
        .single()

      if (error) throw error

      setBusiness((current) => ({
        ...current,
        published: data.status === 'published',
        isSuspended: data.is_suspended,
        isOwnerPaused: data.is_owner_paused,
      }))
      await loadPublicClients()
      setSaveMessage(
        isOwnerPaused
          ? 'Seu site foi retirado do ar.'
          : 'Seu site foi publicado novamente.'
      )
    } catch (error) {
      const supabaseError = error as {
        code?: string
        message?: string
        details?: string
        hint?: string
      }
      console.error(
        isOwnerPaused
          ? 'Falha ao tirar o site do ar no Supabase.'
          : 'Falha ao publicar o site novamente no Supabase.',
        {
          code: supabaseError.code,
          message: supabaseError.message,
          details: supabaseError.details,
          hint: supabaseError.hint,
        }
      )
      setSaveMessage(
        'Não foi possível alterar a publicação do site. Tente novamente.'
      )
    } finally {
      savingBusinessRef.current = false
      setSavingBusiness(false)
    }
  }

  const back = () => {
    setSaveMessage('')

    if (business.step === 0) {
      setView('dashboard')
      return
    }

    update({
      step: business.step - 1,
    })
  }

  /*
   * ============================================================
   * UPLOAD DE FOTOS
   * ============================================================
   */
  const addPhotos = async (
    event: ChangeEvent<HTMLInputElement>
  ) => {
    const availableSlots = Math.max(0, 5 - business.photos.length)
    const files = Array.from(event.target.files || []).slice(0, availableSlots)

    const uploadedPhotos = await Promise.all(
      files.map(async (file) => {
        try {
          validateBusinessImage(file)

          if (!currentUserId || !business.id) {
            return {
              url: URL.createObjectURL(file),
              title: '',
              description: '',
            }
          }

          return {
            url: await uploadBusinessMedia(
              file,
              currentUserId,
              business.id,
              'gallery'
            ),
            title: '',
            description: '',
          }
        } catch (error) {
          if (error instanceof BusinessMediaValidationError) {
            setSaveMessage(error.message)
            return null
          }

          console.error(
            'Falha ao enviar foto para o Supabase Storage:',
            error
          )
          setSaveMessage(
            'Não foi possível enviar uma foto. A prévia local será perdida ao recarregar a página.'
          )
          return {
            url: URL.createObjectURL(file),
            title: '',
            description: '',
          }
        }
      })
    )

    update({
      photos: [
        ...business.photos,
        ...uploadedPhotos.filter(
          (photo): photo is { url: string; title: string; description: string } =>
            photo !== null
        ),
      ].slice(0, 5),
    })

    event.target.value = ''
  }

  /*
   * ============================================================
   * LOGIN
   * ============================================================
   */
  if (view === 'admin' && signedIn && isAdmin) {
    return (
      <Admin
        header={
          <Header
            requestedSite={requestedSite}
            signedIn={signedIn}
            isAdmin={isAdmin}
            accountName={accountName}
            accountEmail={accountEmail}
            accountAvatarUrl={accountAvatarUrl}
            menuOpen={menuOpen}
            setMenuOpen={setMenuOpen}
            start={start}
            logout={logout}
            setView={setView}
          />
        }
        onBack={() => setView('dashboard')}
      />
    )
  }

  if (view === 'login') {
    return (
      <main className="auth-page">
        <section className="auth-shell">
          <div className="auth-brand">
            <Brand onClick={() => setView('home')} />
          </div>

          <div className="auth-card">
            <p className="eyebrow centered-eyebrow">
              Área do empreendedor
            </p>

            <h1>Entre no PortalMicro</h1>

            <p className="auth-description">
              Acesse seu painel e continue cuidando da presença digital do seu
              negócio.
            </p>

            <button
              className="google-button"
              onClick={signIn}
            >
              <span className="google-g">
                G
              </span>

              Continuar com Google
            </button>

            {authMessage && (
              <p className="auth-message">
                {authMessage}
              </p>
            )}

            {import.meta.env.DEV && (
              <div className="auth-demo">
                <button className="demo-button" onClick={demoSignIn}>
                  Continuar em modo demonstração
                </button>
                <small>Disponível apenas no ambiente local de desenvolvimento.</small>
              </div>
            )}

            <button
              className="back-link"
              onClick={() =>
                setView('home')
              }
            >
              <ArrowLeft size={15} />
              Voltar
            </button>
          </div>
        </section>
      </main>
    )
  }

  /*
   * ============================================================
   * DASHBOARD
   * ============================================================
   */
  if (view === 'dashboard') {
    return (
      <main>
        <Header
          requestedSite={requestedSite}
          signedIn={signedIn}
          isAdmin={isAdmin}
          accountName={accountName}
          accountEmail={accountEmail}
          accountAvatarUrl={accountAvatarUrl}
          menuOpen={menuOpen}
          setMenuOpen={setMenuOpen}
          start={start}
          logout={logout}
          setView={setView}
        />

        <section className="dashboard container">
          <div className="dashboard-top">
            <div>
              <p className="eyebrow">
                <Sparkles size={16} />
                Área do empreendedor
              </p>

              <h1>
                Olá, <em>{accountName}.</em>
              </h1>

              <p className="hero-text">
                Seu espaço de criação fica salvo
                automaticamente neste navegador.
              </p>
            </div>

            <button
              className="button"
              onClick={() =>
                setView('wizard')
              }
            >
              {business.step
                ? 'Continuar criação'
                : 'Começar meu site'}{' '}
              <ArrowRight size={18} />
            </button>
          </div>

          <div className={`dashboard-grid${business.published ? ' is-complete' : ''}`}>
            <article className="status-panel">
              <div className="panel-heading">
                <div className="panel-title-block">
                  <span className="panel-kicker">
                    SITE INSTITUCIONAL
                  </span>

                  <div className="panel-title-row">
                    <h2>
                      {business.name ||
                        'Seu negócio'}
                    </h2>

                    <span
                      className={`status ${
                        !business.published
                          ? 'draft'
                          : business.isSuspended
                            ? 'suspended'
                            : business.isOwnerPaused
                              ? 'paused'
                              : 'published'
                      }`}
                    >
                      {!business.published
                        ? 'Rascunho'
                        : business.isSuspended
                          ? 'Suspenso'
                          : business.isOwnerPaused
                            ? 'Fora do ar'
                            : 'Publicado'}
                    </span>
                  </div>
                </div>
              </div>

              <p className="site-status-description">
                {!business.published
                  ? 'Seu site ainda não está disponível para o público.'
                  : business.isSuspended
                    ? 'Seu site está temporariamente indisponível. Entre em contato com o suporte se precisar de mais informações.'
                    : business.isOwnerPaused
                      ? 'Seu site está temporariamente fora do ar. Seus dados continuam salvos.'
                      : 'Seu site está publicado e visível para seus clientes.'}
              </p>

              <div className="progress-row">
                <span>
                  Progresso da criação
                </span>

                <strong>
                  {wizardProgress}
                  %
                </strong>
              </div>

              <div className="progress">
                <span
                  style={{
                    width: `${wizardProgress}%`,
                  }}
                />
              </div>

              <div className={`panel-actions${business.published && business.isSuspended ? ' single-action' : ''}`}>
                <button
                  className={`button${business.published && !business.isSuspended && !business.isOwnerPaused ? '' : ' button-outline'}`}
                  onClick={
                    business.published && !business.isSuspended && !business.isOwnerPaused
                      ? updatePublicSite
                      : () => setView('wizard')
                  }
                  disabled={savingBusiness}
                >
                  {business.published && !business.isSuspended && !business.isOwnerPaused
                    ? <Check size={16} />
                    : <Save size={16} />}
                  {business.published && !business.isSuspended && !business.isOwnerPaused
                    ? 'Atualizar site público'
                    : 'Editar informações'}
                </button>

                {!(business.published && business.isSuspended) && <button
                  className={`button${business.published && !business.isOwnerPaused ? ' button-outline' : ''}`}
                  onClick={
                    !business.published
                      ? publish
                      : business.isOwnerPaused
                        ? () => setSiteOwnerPaused(false)
                        : () => setShowTakeOfflineConfirmation(true)
                  }
                  disabled={savingBusiness}
                >
                  {business.published && !business.isOwnerPaused
                    ? <EyeOff size={16} />
                    : <Check size={16} />}

                  {!business.published
                    ? 'Publicar site'
                    : business.isOwnerPaused
                      ? 'Publicar novamente'
                      : 'Tirar site do ar'}
                </button>}
              </div>

              {showTakeOfflineConfirmation && business.published && !business.isSuspended && !business.isOwnerPaused && (
                <div className="take-offline-confirmation" role="dialog" aria-modal="false" aria-labelledby="take-offline-title">
                  <div>
                    <strong id="take-offline-title">Tirar seu site do ar?</strong>
                    <p>Ele deixará de aparecer para os clientes, mas seus dados continuarão salvos.</p>
                  </div>
                  <div className="confirmation-actions">
                    <button className="button button-outline button-small" onClick={() => setShowTakeOfflineConfirmation(false)} disabled={savingBusiness}>Cancelar</button>
                    <button className="button button-small" onClick={() => { setShowTakeOfflineConfirmation(false); void setSiteOwnerPaused(true) }} disabled={savingBusiness}><EyeOff size={15} /> Tirar do ar</button>
                  </div>
                </div>
              )}

              {business.publicUrl && (
                <div className="public-address">
                  <span>Endereço público</span>
                  <a className="public-url" href={business.publicUrl}>
                    {business.publicUrl}
                  </a>
                </div>
              )}

              <div className="dashboard-template-summary">
                <div>
                  <span>Modelo da página</span>
                  <strong>{business.templateKey === 'featured' ? 'Destaque' : business.templateKey === 'essential' ? 'Essencial' : 'Não escolhido'}</strong>
                </div>
                <button
                  className="template-dashboard-link"
                  onClick={() => {
                    setTemplateMessage('')
                    setView(business.published ? 'template' : 'wizard')
                    if (!business.published && business.step >= 5) update({ step: 6 })
                  }}
                >
                  {business.step < 5 && !business.published
                    ? 'Concluir cadastro'
                    : business.templateKey
                      ? 'Alterar modelo'
                      : 'Escolher modelo'}
                  <ArrowRight size={16} />
                </button>
              </div>
            </article>

            {!business.published && <aside className="next-panel">
              <span className="step-number">
                {String(
                  Math.min(
                    business.step + 1,
                    7
                  )
                ).padStart(2, '0')}
              </span>

              <h3>
                {business.step === 6
                  ? business.templateKey
                    ? 'Tudo pronto para publicar'
                    : 'Escolha um modelo para publicar'
                  : `Próximo: ${
                      stepNames[
                        business.step
                      ]
                    }`}
              </h3>

              <p>
                Responda algumas perguntas e
                deixe o assistente organizar sua
                presença digital.
              </p>

              <button
                className="text-link"
                onClick={() =>
                  setView('wizard')
                }
              >
                Abrir assistente{' '}
                <ArrowRight size={16} />
              </button>
            </aside>}
          </div>

          <div className="privacy-note">
            <Save size={16} />

            <span>
              Dados salvos localmente. A
              publicação só acontece quando você
              autorizar.
            </span>
          </div>

          {saveMessage && (
            <p className="field-message">
              {saveMessage}
            </p>
          )}
        </section>
      </main>
    )
  }

  if (view === 'template' && signedIn) {
    return (
      <BusinessTemplateSelection
        header={
          <Header
            requestedSite={requestedSite}
            signedIn={signedIn}
            isAdmin={isAdmin}
            accountName={accountName}
            accountEmail={accountEmail}
            accountAvatarUrl={accountAvatarUrl}
            menuOpen={menuOpen}
            setMenuOpen={setMenuOpen}
            start={start}
            logout={logout}
            setView={setView}
          />
        }
        business={business}
        saving={savingTemplate}
        message={templateMessage}
        onBack={() => setView('dashboard')}
        onSave={(templateKey) => void saveTemplate(templateKey)}
      />
    )
  }

  /*
   * ============================================================
   * WIZARD
   * ============================================================
   */
  if (view === 'wizard') {
    return (
      <main>
        <Header
          requestedSite={requestedSite}
          signedIn={signedIn}
          isAdmin={isAdmin}
          accountName={accountName}
          accountEmail={accountEmail}
          accountAvatarUrl={accountAvatarUrl}
          menuOpen={menuOpen}
          setMenuOpen={setMenuOpen}
          start={start}
          logout={logout}
          setView={setView}
        />

        <section className="wizard-shell container">
          <div className="wizard-intro">
            <button
              className="back-link"
              onClick={() =>
                setView('dashboard')
              }
            >
              <ArrowLeft size={15} />
              Meu painel
            </button>

            <p className="eyebrow">
              <Sparkles size={16} />
              Assistente portalMicro
            </p>

            <h1>
              Vamos dar voz ao
              <br />
              <em>seu negócio.</em>
            </h1>

            <p>
              Você pode voltar quando quiser. Nós
              salvamos cada resposta.
            </p>
          </div>

          <div className="wizard-card">
            <div className="stepper">
              {stepNames.map(
                (step, index) => (
                  <button
                    key={step}
                    className={
                      index ===
                      business.step
                        ? 'active'
                        : index <
                            business.step
                          ? 'done'
                          : ''
                    }
                    onClick={() => {
                      if (index > business.step) return

                      setSaveMessage('')
                      update({
                        step: index,
                      })
                    }}
                  >
                    <span>
                      {index <
                      business.step ? (
                        <Check size={14} />
                      ) : (
                        index + 1
                      )}
                    </span>

                    {step}
                  </button>
                )
              )}
            </div>

            <WizardQuestion
              business={business}
              update={update}
              addPhotos={addPhotos}
              uploadLogo={uploadLogo}
              mediaUrl={publicMediaUrl}
              savingTemplate={savingTemplate}
              templateMessage={templateMessage}
              onSaveTemplate={(templateKey) => void saveTemplate(templateKey)}
              validationMessage={
                business.step === 2 &&
                saveMessage === 'Selecione como você atende seus clientes.'
                  ? saveMessage
                  : business.step === 3 &&
                      (saveMessage ===
                        'Conte um pouco mais sobre seu negócio. Use pelo menos 30 caracteres.' ||
                        saveMessage ===
                          'A história do negócio deve ter no máximo 1000 caracteres.')
                    ? saveMessage
                  : ''
              }
            />

            {saveMessage &&
              (business.step !== 2 ||
                saveMessage !==
                  'Selecione como você atende seus clientes.') &&
              (business.step !== 3 ||
                (saveMessage !==
                  'Conte um pouco mais sobre seu negócio. Use pelo menos 30 caracteres.' &&
                  saveMessage !==
                    'A história do negócio deve ter no máximo 1000 caracteres.')) && (
              <p className="field-message">
                {saveMessage}
              </p>
            )}

            <div className="wizard-footer">
              <button
                className="button button-outline"
                onClick={back}
              >
                <ArrowLeft size={16} />
                Voltar
              </button>

              {business.step < 6 ? (
                <button
                  className="button"
                  onClick={next}
                  disabled={savingBusiness}
                >
                  {savingBusiness
                    ? 'Salvando...'
                    : 'Salvar e continuar'}{' '}
                  <ArrowRight size={16} />
                </button>
              ) : (
                <button
                  className="button"
                  onClick={publish}
                  disabled={savingBusiness || savingTemplate || !business.templateKey}
                >
                  <Check size={16} />
                  {savingBusiness
                    ? 'Salvando...'
                    : business.templateKey
                      ? 'Publicar site'
                      : 'Escolha um modelo'}
                </button>
              )}
            </div>
          </div>
        </section>
      </main>
    )
  }

  /*
   * ============================================================
   * PREVIEW
   * ============================================================
   */
  if (view === 'preview') {
    return (
      <main>
        <Header
          requestedSite={requestedSite}
          signedIn={signedIn}
          isAdmin={isAdmin}
          accountName={accountName}
          accountEmail={accountEmail}
          accountAvatarUrl={accountAvatarUrl}
          menuOpen={menuOpen}
          setMenuOpen={setMenuOpen}
          start={start}
          logout={logout}
          setView={setView}
        />

        <section className="public-preview container">
          {pageOwner && (
            <aside className="owner-preview-context" aria-label="Controles da pré-visualização">
              <div className="owner-preview-heading">
                <div>
                  <span>Área do proprietário</span>
                  <strong>Pré-visualização do seu site</strong>
                </div>
                <span className={`preview-context-status ${
                  !business.published
                    ? 'private'
                    : business.isSuspended
                      ? 'suspended'
                      : business.isOwnerPaused
                        ? 'paused'
                        : 'published'
                }`}>
                  {!business.published
                    ? 'Prévia privada'
                    : business.isSuspended
                      ? 'Suspenso'
                      : business.isOwnerPaused
                        ? 'Fora do ar'
                        : 'Publicado'}
                </span>
              </div>

              <div className="owner-preview-actions">
                <button className="button button-small button-outline" onClick={() => leavePublicPreview('dashboard')}>
                  <ArrowLeft size={15} /> Meu painel
                </button>
                <button className="button button-small button-outline" onClick={() => leavePublicPreview('template')}>
                  Alterar modelo
                </button>
                <button
                  className="button button-small"
                  onClick={
                    !business.published
                      ? publish
                      : business.isSuspended
                        ? () => setView('wizard')
                        : business.isOwnerPaused
                          ? () => setSiteOwnerPaused(false)
                          : updatePublicSite
                  }
                  disabled={savingBusiness}
                >
                  {!business.published
                    ? 'Publicar site'
                    : business.isSuspended
                      ? 'Editar informações'
                      : business.isOwnerPaused
                        ? 'Publicar novamente'
                        : 'Atualizar site público'}
                  <Globe size={15} />
                </button>
              </div>
            </aside>
          )}

          {saveMessage && (
            <p className="field-message">{saveMessage}</p>
          )}

          {business.templateKey === 'featured'
            ? <BusinessTemplateFeatured business={business} />
            : <BusinessTemplateEssential business={business} />}
        </section>
      </main>
    )
  }

  return (
    <Home
      header={
        <Header
          requestedSite={requestedSite}
          signedIn={signedIn}
          isAdmin={isAdmin}
          accountName={accountName}
          accountEmail={accountEmail}
          accountAvatarUrl={accountAvatarUrl}
          menuOpen={menuOpen}
          setMenuOpen={setMenuOpen}
          start={start}
          logout={logout}
          setView={setView}
        />
      }
      clients={clients}
      start={start}
      signedIn={signedIn}
      selectedCity={selectedCity}
      onBrandClick={() => setView('home')}
    />
  )
}

export default App
