import { ArrowLeft, ImagePlus, Save, ShieldCheck, X } from 'lucide-react'
import { ChangeEvent, FormEvent, useEffect, useState } from 'react'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { supabase } from '../lib/supabase'
import { businessPhotoDescriptionLimit } from '../constants/portal'
import type { AdminBusinessEdit as AdminBusinessEditData } from '../types/business'
import { formatCep } from '../utils/formatters'
import {
  BusinessMediaValidationError,
  getBusinessMediaUrl,
  uploadBusinessMedia,
  validateBusinessImage,
} from '../utils/storage'

interface AdminBusinessEditProps {
  businessId: string
  onCancel: () => void
  onSaved: () => Promise<void>
}

const emptyForm: AdminBusinessEditData = {
  id: '',
  owner_id: '',
  logo_path: null,
  name: '',
  category: '',
  story: '',
  service_type: null,
  cep: '',
  street: '',
  number: '',
  complement: '',
  neighborhood: '',
  city: '',
  show_address: true,
  contact_email: '',
  whatsapp: '',
}

type AdminPhoto = {
  id: string
  image_path: string
  description: string
  position: number
}

export function AdminBusinessEdit({
  businessId,
  onCancel,
  onSaved,
}: AdminBusinessEditProps) {
  const [form, setForm] = useState<AdminBusinessEditData>(emptyForm)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [photos, setPhotos] = useState<AdminPhoto[]>([])
  const [mediaProcessing, setMediaProcessing] = useState('')
  const [mediaMessage, setMediaMessage] = useState('')
  const [photoPendingRemoval, setPhotoPendingRemoval] = useState<AdminPhoto | null>(null)

  useEffect(() => {
    let active = true

    const loadBusiness = async () => {
      const [businessResult, itemsResult] = await Promise.all([
        supabase
          .from('businesses')
          .select(
            'id, owner_id, logo_path, name, category, story, service_type, cep, street, number, complement, neighborhood, city, show_address, contact_email, whatsapp'
          )
          .eq('id', businessId)
          .single(),
        supabase
          .from('business_items')
          .select('id, image_path, description, position')
          .eq('business_id', businessId)
          .order('position', { ascending: true }),
      ])

      if (!active) return

      if (businessResult.error || itemsResult.error) {
        console.error(
          'Falha ao carregar negócio para edição:',
          businessResult.error ?? itemsResult.error
        )
        setMessage('Não foi possível carregar os dados do negócio.')
      } else {
        setForm(businessResult.data)
        setPhotos(
          (itemsResult.data ?? [])
            .filter((item) => Boolean(item.image_path))
            .slice(0, 5)
            .map((item, index) => ({
              id: item.id,
              image_path: item.image_path ?? '',
              description: item.description ?? '',
              position: item.position ?? index,
            }))
        )
      }

      setLoading(false)
    }

    void loadBusiness()

    return () => {
      active = false
    }
  }, [businessId])

  const update = (patch: Partial<AdminBusinessEditData>) => {
    setForm((current) => ({ ...current, ...patch }))
  }

  const removeStorageObjectIfUnused = async (path: string) => {
    const [businessReferences, itemReferences] = await Promise.all([
      supabase.from('businesses').select('id').eq('logo_path', path).limit(1),
      supabase.from('business_items').select('id').eq('image_path', path).limit(1),
    ])

    if (businessReferences.error || itemReferences.error) {
      console.error(
        'Falha ao verificar referências do arquivo:',
        businessReferences.error ?? itemReferences.error
      )
      return false
    }

    if (businessReferences.data?.length || itemReferences.data?.length) {
      return true
    }

    const { error } = await supabase.storage
      .from('business-media')
      .remove([path])

    if (error) {
      console.error('Falha ao remover arquivo sem referências:', error)
      return false
    }

    return true
  }

  const replaceLogo = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || mediaProcessing) return

    try {
      validateBusinessImage(file)
      setMediaProcessing('logo')
      setMediaMessage('Enviando novo logo...')

      const newPath = await uploadBusinessMedia(
        file,
        form.owner_id,
        businessId,
        'logo'
      )
      const previousPath = form.logo_path
      const { error } = await supabase.rpc('update_business_admin_logo', {
        target_business_id: businessId,
        new_logo_path: newPath,
      })

      if (error) {
        await supabase.storage.from('business-media').remove([newPath])
        throw error
      }

      update({ logo_path: newPath })

      if (previousPath && !(await removeStorageObjectIfUnused(previousPath))) {
        setMediaMessage(
          'Logo substituído. O arquivo anterior foi preservado por segurança.'
        )
      } else {
        setMediaMessage('Logo substituído com sucesso.')
      }
    } catch (error) {
      console.error('Falha ao substituir logo administrativamente:', error)
      setMediaMessage(
        error instanceof BusinessMediaValidationError
          ? error.message
          : 'Não foi possível substituir o logo.'
      )
    } finally {
      setMediaProcessing('')
    }
  }

  const addPhotos = async (event: ChangeEvent<HTMLInputElement>) => {
    const availableSlots = Math.max(0, 5 - photos.length)
    const files = Array.from(event.target.files ?? []).slice(0, availableSlots)
    event.target.value = ''
    if (!files.length || mediaProcessing) return

    setMediaProcessing('gallery')
    setMediaMessage('Enviando fotos...')
    const addedPhotos: AdminPhoto[] = []

    for (const file of files) {
      let uploadedPath = ''

      try {
        validateBusinessImage(file)
        uploadedPath = await uploadBusinessMedia(
          file,
          form.owner_id,
          businessId,
          'gallery'
        )

        const position = photos.length + addedPhotos.length
        const { data, error } = await supabase
          .from('business_items')
          .insert({
            business_id: businessId,
            image_path: uploadedPath,
            description: '',
            position,
          })
          .select('id, image_path, description, position')
          .single()

        if (error) throw error

        addedPhotos.push({
          id: data.id,
          image_path: data.image_path ?? uploadedPath,
          description: data.description ?? '',
          position: data.position ?? position,
        })
      } catch (error) {
        if (uploadedPath) {
          await supabase.storage.from('business-media').remove([uploadedPath])
        }
        console.error('Falha ao adicionar foto administrativamente:', error)
        setMediaMessage(
          error instanceof BusinessMediaValidationError
            ? error.message
            : 'Uma ou mais fotos não puderam ser adicionadas.'
        )
      }
    }

    if (addedPhotos.length) {
      setPhotos((current) => [...current, ...addedPhotos].slice(0, 5))
      if (addedPhotos.length === files.length) {
        setMediaMessage('Fotos adicionadas com sucesso.')
      }
    }

    setMediaProcessing('')
  }

  const savePhotoDescriptions = async () => {
    if (mediaProcessing || !photos.length) return

    setMediaProcessing('descriptions')
    setMediaMessage('Salvando descrições...')

    const results = await Promise.all(
      photos.map((photo, position) =>
        supabase
          .from('business_items')
          .update({ description: photo.description, position })
          .eq('id', photo.id)
          .eq('business_id', businessId)
      )
    )
    const error = results.find((result) => result.error)?.error

    if (error) {
      console.error('Falha ao salvar descrições das fotos:', error)
      setMediaMessage('Não foi possível salvar todas as descrições.')
    } else {
      setMediaMessage('Descrições salvas com sucesso.')
    }

    setMediaProcessing('')
  }

  const removePhoto = async (photo: AdminPhoto) => {
    if (mediaProcessing) return

    setMediaProcessing(photo.id)
    setMediaMessage('Removendo foto...')

    const { error } = await supabase
      .from('business_items')
      .delete()
      .eq('id', photo.id)
      .eq('business_id', businessId)

    if (error) {
      console.error('Falha ao remover foto da galeria:', error)
      setMediaMessage('Não foi possível remover a foto.')
      setMediaProcessing('')
      return
    }

    const remainingPhotos = photos
      .filter((item) => item.id !== photo.id)
      .map((item, position) => ({ ...item, position }))
    setPhotos(remainingPhotos)

    const positionResults = await Promise.all(
      remainingPhotos.map((item) =>
        supabase
          .from('business_items')
          .update({ position: item.position })
          .eq('id', item.id)
          .eq('business_id', businessId)
      )
    )
    const positionError = positionResults.find((result) => result.error)?.error
    const storageRemoved = await removeStorageObjectIfUnused(photo.image_path)

    if (positionError) {
      console.error('Falha ao reorganizar posições da galeria:', positionError)
    }

    setMediaMessage(
      positionError
        ? 'Foto removida, mas não foi possível reorganizar toda a galeria.'
        : storageRemoved
          ? 'Foto removida com sucesso.'
          : 'Foto removida da galeria; o arquivo foi preservado por segurança.'
    )
    setPhotoPendingRemoval(null)
    setMediaProcessing('')
  }

  const validate = () => {
    if (!form.name?.trim()) return 'Informe o nome do negócio.'
    if ((form.category?.length ?? 0) > 150) {
      return 'A categoria deve ter no máximo 150 caracteres.'
    }
    if ((form.story?.length ?? 0) > 1000) {
      return 'A história deve ter no máximo 1000 caracteres.'
    }
    const storyLength = form.story?.trim().length ?? 0
    if (storyLength > 0 && storyLength < 30) {
      return 'A história deve ter pelo menos 30 caracteres.'
    }

    const cep = form.cep?.replace(/\D/g, '') ?? ''
    if (cep && cep.length !== 8) return 'Informe um CEP com 8 números.'

    const email = form.contact_email?.trim() ?? ''
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return 'Informe um e-mail válido.'
    }

    return ''
  }

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (saving || mediaProcessing) return

    const validationMessage = validate()
    if (validationMessage) {
      setMessage(validationMessage)
      return
    }

    setSaving(true)
    setMessage('')

    const { error } = await supabase.rpc('update_business_admin_details', {
      target_business_id: businessId,
      business_name: form.name?.trim() ?? '',
      business_category: form.category?.trim() || null,
      business_story: form.story || null,
      business_service_type: form.service_type,
      business_cep: form.cep?.replace(/\D/g, '') || null,
      business_street: form.street?.trim() || null,
      business_number: form.number?.trim() || null,
      business_complement: form.complement?.trim() || null,
      business_neighborhood: form.neighborhood?.trim() || null,
      business_city: form.city?.trim() || null,
      business_show_address: form.show_address ?? true,
      business_contact_email: form.contact_email?.trim() || null,
      business_whatsapp: form.whatsapp?.trim() || null,
    })

    if (error) {
      console.error('Falha ao salvar edição administrativa:', error)
      setMessage('Não foi possível salvar as alterações. Tente novamente.')
      setSaving(false)
      return
    }

    setSaving(false)
    await onSaved()
  }

  if (loading) {
    return (
      <div className="admin-message" role="status">
        <p>Carregando dados...</p>
        <button className="button button-small button-outline" onClick={onCancel}>
          Cancelar e voltar
        </button>
      </div>
    )
  }

  if (!form.id) {
    return (
      <div className="admin-message is-error" role="alert">
        <p>{message}</p>
        <button className="button button-small button-outline" onClick={onCancel}>
          Voltar para Administração
        </button>
      </div>
    )
  }

  return (
    <form className="admin-edit-form" onSubmit={save}>
      <div className="admin-edit-heading">
        <div>
          <p className="eyebrow"><ShieldCheck size={16} /> Edição administrativa</p>
          <h1>Editar negócio</h1>
          <p className="hero-text">Altere somente os dados cadastrais autorizados.</p>
        </div>
        <button type="button" className="button button-outline" onClick={onCancel} disabled={saving || Boolean(mediaProcessing)}>
          <ArrowLeft size={16} /> Cancelar
        </button>
      </div>

      {message && <p className="admin-feedback error" role="alert">{message}</p>}

      <div className="admin-edit-grid">
        <label><span>Nome <strong>*</strong></span><input value={form.name ?? ''} onChange={(event) => update({ name: event.target.value })} required /></label>
        <label>Categoria<input value={form.category ?? ''} onChange={(event) => update({ category: event.target.value })} maxLength={150} /></label>
        <label className="admin-edit-wide">História<textarea value={form.story ?? ''} onChange={(event) => update({ story: event.target.value })} rows={7} minLength={30} maxLength={1000} /><span className="field-counter">{form.story?.length ?? 0}/1000 caracteres</span></label>
        <label>Tipo de atendimento<select value={form.service_type ?? ''} onChange={(event) => update({ service_type: (event.target.value || null) as AdminBusinessEditData['service_type'] })}><option value="">Não informado</option><option value="physical">Local físico</option><option value="online">Online</option><option value="both">Físico e online</option></select></label>
        <label>CEP<input value={formatCep(form.cep ?? '')} onChange={(event) => update({ cep: event.target.value.replace(/\D/g, '').slice(0, 8) })} inputMode="numeric" maxLength={9} placeholder="00000-000" /></label>
        <label>Rua<input value={form.street ?? ''} onChange={(event) => update({ street: event.target.value })} /></label>
        <label>Número<input value={form.number ?? ''} onChange={(event) => update({ number: event.target.value })} /></label>
        <label>Complemento<input value={form.complement ?? ''} onChange={(event) => update({ complement: event.target.value })} /></label>
        <label>Bairro<input value={form.neighborhood ?? ''} onChange={(event) => update({ neighborhood: event.target.value })} /></label>
        <label>Cidade<input value={form.city ?? ''} onChange={(event) => update({ city: event.target.value })} /></label>
        <label>E-mail<input type="email" value={form.contact_email ?? ''} onChange={(event) => update({ contact_email: event.target.value })} /></label>
        <label>WhatsApp<input type="tel" value={form.whatsapp ?? ''} onChange={(event) => update({ whatsapp: event.target.value })} /></label>
        <label className="admin-edit-checkbox"><input type="checkbox" checked={form.show_address ?? true} onChange={(event) => update({ show_address: event.target.checked })} /> Exibir endereço na página pública</label>
      </div>

      <section className="admin-media-section">
        <div className="admin-media-heading">
          <div>
            <span className="panel-kicker">MÍDIA</span>
            <h2>Logo e fotos</h2>
          </div>
          <span>{photos.length}/5 fotos</span>
        </div>

        {mediaMessage && (
          <p className="admin-media-message" role="status">{mediaMessage}</p>
        )}

        <div className="admin-logo-editor">
          <div className="admin-logo-preview">
            {form.logo_path ? (
              <img src={getBusinessMediaUrl(form.logo_path)} alt="Logo atual do negócio" />
            ) : (
              <ImagePlus size={28} />
            )}
          </div>
          <div>
            <strong>Logo do negócio</strong>
            <p>JPEG, PNG ou WebP, com no máximo 5 MB.</p>
            <label className={`button button-small button-outline${mediaProcessing ? ' is-disabled' : ''}`}>
              {mediaProcessing === 'logo' ? 'Enviando...' : form.logo_path ? 'Substituir logo' : 'Adicionar logo'}
              <input type="file" accept="image/jpeg,image/png,image/webp" onChange={replaceLogo} disabled={Boolean(mediaProcessing) || saving} />
            </label>
          </div>
        </div>

        <div className="admin-gallery-heading">
          <div>
            <strong>Galeria</strong>
            <p>Adicione até 5 fotos e edite suas descrições.</p>
          </div>
          <label className={`button button-small button-outline${photos.length >= 5 || mediaProcessing ? ' is-disabled' : ''}`}>
            {mediaProcessing === 'gallery' ? 'Enviando...' : 'Adicionar fotos'}
            <input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={addPhotos} disabled={photos.length >= 5 || Boolean(mediaProcessing) || saving} />
          </label>
        </div>

        {photos.length === 0 ? (
          <div className="admin-media-empty">Nenhuma foto na galeria.</div>
        ) : (
          <div className="admin-media-list">
            {photos.map((photo, index) => (
              <article className="admin-media-item" key={photo.id}>
                <img src={getBusinessMediaUrl(photo.image_path)} alt="" />
                <div>
                  <textarea
                    value={photo.description}
                    onChange={(event) => setPhotos((current) => current.map((item) => item.id === photo.id ? { ...item, description: event.target.value } : item))}
                    aria-label={`Descrição da foto ${index + 1}`}
                    placeholder="Descreva este produto ou serviço"
                    rows={3}
                    maxLength={businessPhotoDescriptionLimit}
                    disabled={Boolean(mediaProcessing) || saving}
                  />
                  <span className={`field-counter${photo.description.length > businessPhotoDescriptionLimit * .9 ? ' near-limit' : ''}`}>{photo.description.length} / {businessPhotoDescriptionLimit} caracteres</span>
                </div>
                <button type="button" onClick={() => setPhotoPendingRemoval(photo)} disabled={Boolean(mediaProcessing) || saving} aria-label={`Remover foto ${index + 1}`}>
                  {mediaProcessing === photo.id ? '...' : <X size={16} />}
                </button>
              </article>
            ))}
          </div>
        )}

        {photos.length > 0 && (
          <div className="admin-media-actions">
            <button type="button" className="button button-small button-outline" onClick={() => void savePhotoDescriptions()} disabled={Boolean(mediaProcessing) || saving}>
              {mediaProcessing === 'descriptions' ? 'Salvando...' : 'Salvar descrições'}
            </button>
          </div>
        )}
      </section>

      {photoPendingRemoval && (
        <ConfirmDialog
          title="Remover foto?"
          description="Esta foto será removida da galeria deste negócio."
          confirmLabel="Remover foto"
          processingLabel="Removendo..."
          processing={mediaProcessing === photoPendingRemoval.id}
          previewUrl={getBusinessMediaUrl(photoPendingRemoval.image_path)}
          onCancel={() => setPhotoPendingRemoval(null)}
          onConfirm={() => void removePhoto(photoPendingRemoval)}
        />
      )}

      <div className="admin-edit-footer">
        <button type="button" className="button button-outline" onClick={onCancel} disabled={saving || Boolean(mediaProcessing)}>Cancelar</button>
        <button type="submit" className="button" disabled={saving || Boolean(mediaProcessing)}><Save size={16} /> {saving ? 'Salvando...' : 'Salvar alterações'}</button>
      </div>
    </form>
  )
}
