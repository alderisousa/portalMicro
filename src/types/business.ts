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
