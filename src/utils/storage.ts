import { supabase } from '../lib/supabase'

const allowedImageTypes = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
])

const maximumImageSize = 5 * 1024 * 1024

export class BusinessMediaValidationError extends Error {}

export const validateBusinessImage = (file: File) => {
  if (!allowedImageTypes.has(file.type)) {
    throw new BusinessMediaValidationError(
      'Use uma imagem JPEG, PNG ou WebP.'
    )
  }

  if (file.size > maximumImageSize) {
    throw new BusinessMediaValidationError(
      'A imagem deve ter no máximo 5 MB.'
    )
  }
}

export const uploadBusinessMedia = async (
  file: File,
  userId: string,
  businessId: string,
  kind: 'logo' | 'gallery'
) => {
  validateBusinessImage(file)

  const extension = allowedImageTypes.get(file.type)
  const folder = kind === 'gallery' ? 'items' : 'logo'
  const path =
    `${userId}/${businessId}/${folder}/${crypto.randomUUID()}.${extension}`

  const { error } = await supabase.storage
    .from('business-media')
    .upload(path, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: file.type,
    })

  if (error) throw error

  return path
}
