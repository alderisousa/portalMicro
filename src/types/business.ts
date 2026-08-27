export type Photo = {
  id?: string
  url: string
  description: string
}

export type Business = {
  id?: string
  slug?: string
  area: string
  name: string
  logo: string
  location: 'fisico' | 'online' | 'ambos' | ''
  address: string
  cep: string
  street: string
  neighborhood: string
  city: string
  number: string
  complement: string
  showAddress: boolean
  story: string
  photos: Photo[]
  whatsapp: string
  email: string
  published: boolean
  isSuspended?: boolean
  isOwnerPaused?: boolean
  publicUrl: string
  step: number
  ownerId?: string
}

export type ClientSummary = {
  slug: string
  name: string
  area: string
  logo: string
}

export type AdminBusinessSummary = {
  id: string
  name: string | null
  slug: string | null
  category: string | null
  city: string | null
  status: string
  is_suspended: boolean
  is_owner_paused: boolean
  owner_id: string
  created_at: string
  updated_at: string
}

export type AdminBusinessEdit = {
  id: string
  name: string | null
  category: string | null
  story: string | null
  service_type: 'physical' | 'online' | 'both' | null
  cep: string | null
  street: string | null
  number: string | null
  complement: string | null
  neighborhood: string | null
  city: string | null
  show_address: boolean | null
  contact_email: string | null
  whatsapp: string | null
}
