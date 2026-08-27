import {
  ArrowLeft,
  ArrowRight,
  Check,
  EyeOff,
  Globe,
  MessageCircle,
  Save,
  Sparkles,
} from 'lucide-react'
import { ChangeEvent, useEffect, useRef, useState } from 'react'
import { Header } from './components/Header'
import { StoryContent } from './components/StoryContent'
import { WizardQuestion } from './components/WizardQuestion'
import { selectedCity, stepNames } from './constants/portal'
import { supabase } from './lib/supabase'
import { Home } from './pages/Home'
import type { Business, ClientSummary } from './types/business'
import { formatAddress, formatCep } from './utils/formatters'
import {
  BusinessMediaValidationError,
  uploadBusinessMedia,
  validateBusinessImage,
} from './utils/storage'

const storageKey = 'portalmicro-business'
const sessionKey = 'portalmicro-session'

const requestedSite =
  new URLSearchParams(window.location.search).get('site')

const emptyBusiness: Business = {
  area: '',
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
  publicUrl: '',
  step: 0,
}

type BusinessRecord = {
  id: string
  slug: string | null
  owner_id: string
  name: string | null
  category: string | null
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
  is_suspended?: boolean | null
  is_owner_paused?: boolean | null
}

type BusinessItemRecord = {
  id: string
  image_path: string | null
  description: string | null
}

const publicMediaUrl = (path: string | null) => {
  if (!path || path.startsWith('blob:')) return path ?? ''

  return supabase.storage
    .from('business-media')
    .getPublicUrl(path).data.publicUrl
}

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
        description: item.description ?? '',
      })),
    whatsapp: data.whatsapp ?? '',
    email: data.contact_email ?? '',
    ownerId: data.owner_id,
    published: data.status === 'published',
    isSuspended: data.is_suspended ?? false,
    isOwnerPaused: data.is_owner_paused ?? false,
  }

  mappedBusiness.address = formatAddress({
    ...emptyBusiness,
    ...mappedBusiness,
  })

  return mappedBusiness
}

function App() {
  const [view, setView] = useState<
    'home' | 'login' | 'dashboard' | 'wizard' | 'preview'
  >(() => (requestedSite ? 'preview' : 'home'))

  const [menuOpen, setMenuOpen] = useState(false)

  const [signedIn, setSignedIn] = useState(
    () => localStorage.getItem(sessionKey) === 'demo-user'
  )

  const [accountName, setAccountName] = useState('empreendedor')
  const [authMessage, setAuthMessage] = useState('')
  const [currentUserId, setCurrentUserId] = useState('')
  const [saveMessage, setSaveMessage] = useState('')
  const [savingBusiness, setSavingBusiness] = useState(false)
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

  const loadedOwnedBusinessUserId = useRef('')
  const savingBusinessRef = useRef(false)
  const pendingLogoFile = useRef<File | null>(null)

  const loadOwnedBusiness = async (userId: string) => {
    if (requestedSite || loadedOwnedBusinessUserId.current === userId) {
      return
    }

    loadedOwnedBusinessUserId.current = userId

    const { data: businesses, error } = await supabase
      .from('businesses')
      .select(
        'id, owner_id, slug, name, category, story, service_type, logo_path, cep, street, number, complement, neighborhood, city, show_address, contact_email, whatsapp, status, is_suspended, is_owner_paused'
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
      .select('id, image_path, description')
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

    setBusiness((current) => ({
      ...current,
      ...mappedBusiness,
      step: current.step,
      publicUrl: current.publicUrl,
    }))
  }

  const saveBusiness = async () => {
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
        setSignedIn(true)
        setCurrentUserId(user.id)

        setAccountName(
          user.user_metadata?.full_name ||
            user.user_metadata?.name ||
            user.email?.split('@')[0] ||
            'empreendedor'
        )

        setBusiness((current) => ({
          ...current,
          email: current.email || user.email || '',
          ownerId: user.id,
        }))

        loadOwnedBusiness(user.id)
      } else {
        setSignedIn(false)
        setCurrentUserId('')
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
          setSignedIn(true)
          setCurrentUserId(user.id)

          setAccountName(
            user.user_metadata?.full_name ||
              user.user_metadata?.name ||
              user.email?.split('@')[0] ||
              'empreendedor'
          )

          setBusiness((current) => ({
            ...current,
            email: current.email || user.email || '',
            ownerId: user.id,
          }))

          loadOwnedBusiness(user.id)
        } else {
          setSignedIn(false)
          setCurrentUserId('')
          setAccountName('empreendedor')
          loadedOwnedBusinessUserId.current = ''
        }
      }
    )

    return () => {
      mounted = false
      subscription.unsubscribe()
    }
  }, [])

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
    if (requestedSite) return

    loadPublicClients()
  }, [])

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
          'id, owner_id, name, slug, category, story, service_type, logo_path, cep, street, number, complement, neighborhood, city, show_address, contact_email, whatsapp, status'
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
        .select('id, image_path, description')
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

    setSignedIn(false)
    setCurrentUserId('')
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
    }

    setSaveMessage('')

    update({
      step: Math.min(
        business.step + 1,
        5
      ),
    })

    setView('wizard')
  }

  const publish = async () => {
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
      await loadPublicClients()
      setSaveMessage('Negócio publicado com sucesso.')
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
            description: '',
          }
        }
      })
    )

    update({
      photos: [
        ...business.photos,
        ...uploadedPhotos.filter(
          (photo): photo is { url: string; description: string } =>
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
  if (view === 'login') {
    return (
      <main>
        <Header
          selectedCity={selectedCity}
          requestedSite={requestedSite}
          signedIn={signedIn}
          pageOwner={pageOwner}
          menuOpen={menuOpen}
          setMenuOpen={setMenuOpen}
          start={start}
          logout={logout}
          setView={setView}
        />

        <section className="auth-shell">
          <div className="auth-card">
            <span className="brand-mark large">
              M
            </span>

            <p className="eyebrow centered-eyebrow">
              Seu espaço em {selectedCity}
            </p>

            <h1>
              Vamos começar
              <br />
              <em>pelo seu negócio.</em>
            </h1>

            <p>
              Entre com sua conta Google para
              salvar seu progresso e criar sua
              página institucional.
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

            <button
              className="demo-button"
              onClick={demoSignIn}
            >
              Continuar em modo demonstração
            </button>

            <small>
              O modo demonstração salva os
              dados apenas neste navegador.
            </small>

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
          selectedCity={selectedCity}
          requestedSite={requestedSite}
          signedIn={signedIn}
          pageOwner={pageOwner}
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

          <div className={`dashboard-grid${business.step === 5 && business.published ? ' is-complete' : ''}`}>
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
                  {business.step === 5
                    ? '100'
                    : Math.round(
                        (business.step /
                          6) *
                          100
                      )}
                  %
                </strong>
              </div>

              <div className="progress">
                <span
                  style={{
                    width: `${
                      business.step === 5
                        ? 100
                        : (business.step /
                            6) *
                          100
                    }%`,
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
            </article>

            {!(business.step === 5 && business.published) && <aside className="next-panel">
              <span className="step-number">
                {String(
                  Math.min(
                    business.step + 1,
                    6
                  )
                ).padStart(2, '0')}
              </span>

              <h3>
                {business.step === 5
                  ? 'Tudo pronto para publicar'
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

  /*
   * ============================================================
   * WIZARD
   * ============================================================
   */
  if (view === 'wizard') {
    return (
      <main>
        <Header
          selectedCity={selectedCity}
          requestedSite={requestedSite}
          signedIn={signedIn}
          pageOwner={pageOwner}
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

              {business.step < 5 ? (
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
                  disabled={savingBusiness}
                >
                  <Check size={16} />
                  {savingBusiness
                    ? 'Salvando...'
                    : 'Concluir cadastro'}
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
          selectedCity={selectedCity}
          requestedSite={requestedSite}
          signedIn={signedIn}
          pageOwner={pageOwner}
          menuOpen={menuOpen}
          setMenuOpen={setMenuOpen}
          start={start}
          logout={logout}
          setView={setView}
        />

        <section className="public-preview container">
          <div className="preview-toolbar">
            {pageOwner && (
              <button
                className="back-link"
                onClick={() =>
                  setView('dashboard')
                }
              >
                <ArrowLeft size={15} />
                Meu painel
              </button>
            )}

            <span
              className={`status ${
                business.published && !business.isSuspended && !business.isOwnerPaused
                  ? 'published'
                  : ''
              }`}
            >
              {!business.published
                ? 'Prévia privada'
                : business.isSuspended
                  ? 'Suspenso'
                  : business.isOwnerPaused
                    ? 'Fora do ar'
                    : 'Site público'}
            </span>

            {pageOwner && (
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
                      : 'Atualizar site público'}{' '}
                <Globe size={15} />
              </button>
            )}
          </div>

          {saveMessage && (
            <p className="field-message">{saveMessage}</p>
          )}

          <article className="business-site">
            <div className="business-cover">
              <div className="business-identity">
                {business.logo && (
                  <img
                    src={publicMediaUrl(business.logo)}
                    alt="Logo"
                  />
                )}

                <h1>
                  {business.name ||
                    'Nome da sua empresa'}
                </h1>
              </div>

              <span>
                {business.area ||
                  'Seu negócio'}
              </span>

              {business.showAddress !==
                false && (
                <small>
                  {formatAddress(
                    business
                  ) ||
                    'Endereço não informado'}
                </small>
              )}
            </div>

            <div className="business-body">
              <StoryContent
                story={business.story}
              />

              <div className="business-photos">
                {business.photos.map(
                  (photo) => (
                    <figure
                      key={photo.url}
                    >
                      <img
                        src={publicMediaUrl(photo.url)}
                        alt={
                          photo.description
                        }
                      />

                      <figcaption>
                        {
                          photo.description
                        }
                      </figcaption>
                    </figure>
                  )
                )}
              </div>

              {business.whatsapp && (
                <a
                  className="button whatsapp-button"
                  href={`https://wa.me/${business.whatsapp.replace(
                    /\D/g,
                    ''
                  )}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <MessageCircle size={18} />
                  Fale conosco no WhatsApp
                </a>
              )}

              {business.publicUrl && (
                <p className="share-note">
                  Endereço público:{' '}
                  <a
                    href={
                      business.publicUrl
                    }
                  >
                    {business.publicUrl}
                  </a>
                </p>
              )}
            </div>
          </article>
        </section>
      </main>
    )
  }

  return (
    <Home
      header={
        <Header
          selectedCity={selectedCity}
          requestedSite={requestedSite}
          signedIn={signedIn}
          pageOwner={pageOwner}
          menuOpen={menuOpen}
          setMenuOpen={setMenuOpen}
          start={start}
          logout={logout}
          setView={setView}
        />
      }
      clients={clients}
      start={start}
      selectedCity={selectedCity}
      onBrandClick={() => setView('home')}
    />
  )
}

export default App
