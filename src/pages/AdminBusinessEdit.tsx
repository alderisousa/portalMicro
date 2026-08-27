import { ArrowLeft, Save, ShieldCheck } from 'lucide-react'
import { FormEvent, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { AdminBusinessEdit as AdminBusinessEditData } from '../types/business'
import { formatCep } from '../utils/formatters'

interface AdminBusinessEditProps {
  businessId: string
  onCancel: () => void
  onSaved: () => Promise<void>
}

const emptyForm: AdminBusinessEditData = {
  id: '',
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

export function AdminBusinessEdit({
  businessId,
  onCancel,
  onSaved,
}: AdminBusinessEditProps) {
  const [form, setForm] = useState<AdminBusinessEditData>(emptyForm)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    let active = true

    const loadBusiness = async () => {
      const { data, error } = await supabase
        .from('businesses')
        .select(
          'id, name, category, story, service_type, cep, street, number, complement, neighborhood, city, show_address, contact_email, whatsapp'
        )
        .eq('id', businessId)
        .single()

      if (!active) return

      if (error) {
        console.error('Falha ao carregar negócio para edição:', error)
        setMessage('Não foi possível carregar os dados do negócio.')
      } else {
        setForm(data)
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
    if (saving) return

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
        <button type="button" className="button button-outline" onClick={onCancel} disabled={saving}>
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

      <div className="admin-edit-footer">
        <button type="button" className="button button-outline" onClick={onCancel} disabled={saving}>Cancelar</button>
        <button type="submit" className="button" disabled={saving}><Save size={16} /> {saving ? 'Salvando...' : 'Salvar alterações'}</button>
      </div>
    </form>
  )
}
