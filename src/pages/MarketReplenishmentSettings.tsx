import { ArrowLeft, Save } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { getMarketReplenishmentSettings, saveMarketReplenishmentSettings, replenishmentSettingsFields, type ReplenishmentSettings, type ReplenishmentSettingsValues } from '../services/marketReplenishmentSettings'
import './MarketReplenishmentSettings.css'

interface Props { accountId: string; onBack: () => void }
type Inputs = Record<keyof ReplenishmentSettingsValues, string>
const toInputs = (settings: ReplenishmentSettings): Inputs => ({
  normal_list_limit: String(settings.normal_list_limit), coverage_target_days: String(settings.coverage_target_days),
  acceleration_threshold_pct: String(settings.acceleration_threshold_pct), essential_no_sale_days: String(settings.essential_no_sale_days),
})

export function MarketReplenishmentSettings({ accountId, onBack }: Props) {
  const [settings, setSettings] = useState<ReplenishmentSettings | null>(null)
  const [inputs, setInputs] = useState<Inputs | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [reload, setReload] = useState(0)
  const pending = useRef(false)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    setSuccess(false)
    setSettings(null)
    setInputs(null)
    void getMarketReplenishmentSettings(accountId).then(result => {
      if (active) { setSettings(result); setInputs(toInputs(result)) }
    }).catch(() => { if (active) setError('Não foi possível carregar as configurações. Tente novamente.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [accountId, reload])

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!settings || !inputs || pending.current) return
    pending.current = true
    setSaving(true)
    setError('')
    setSuccess(false)
    try {
      const values = Object.fromEntries(replenishmentSettingsFields.map(field => [field.key, inputs[field.key].trim() === '' ? NaN : Number(inputs[field.key])])) as ReplenishmentSettingsValues
      const result = await saveMarketReplenishmentSettings(accountId, settings.id, values)
      setSettings(result)
      setInputs(toInputs(result))
      setSuccess(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível salvar. Confira sua permissão e tente novamente. Se a configuração foi criada em outra sessão, volte e abra esta tela novamente.')
    } finally { pending.current = false; setSaving(false) }
  }

  return <div className="replenishment-settings">
    <button className="button button-small button-outline" onClick={onBack} disabled={saving}><ArrowLeft size={16} /> Voltar ao Market</button>
    <header className="market-import-header"><p className="eyebrow">GiroMicro Market · Produtos</p><h1>Configurações da Reposição</h1><p>Configuração padrão do Market, compartilhada pelas lojas.</p></header>
    <p className="admin-message">A inteligência mantém proteções e regras internas que não são configuráveis nesta tela. As alterações serão consideradas nas próximas análises de reposição.</p>
    {loading && <p role="status" className="admin-message">Carregando configurações...</p>}
    {error && <div className="admin-message is-error" role="alert">{error}{!settings && !loading && <button className="button button-small button-outline" onClick={() => setReload(value => value + 1)}>Tentar novamente</button>}</div>}
    {success && <p className="admin-message" role="status">Configurações salvas com sucesso.</p>}
    {!loading && settings && inputs && <form onSubmit={save}>
      {settings.id === null && <p className="admin-message">Ainda não há configuração salva. Os valores padrão estão preenchidos; salve para criar a configuração do Market.</p>}
      <div className="replenishment-settings-grid">{replenishmentSettingsFields.map(field => <div className="replenishment-settings-field" key={field.key}>
        <label htmlFor={field.key}>{field.label}</label>
        <p id={`${field.key}-help`}>{field.help}</p>
        <div className="replenishment-settings-input"><input id={field.key} type="number" inputMode={field.step === 1 ? 'numeric' : 'decimal'} min={field.min} max={field.max} step={field.step} required disabled={saving}
          aria-describedby={`${field.key}-help ${field.key}-range`} value={inputs[field.key]} onChange={event => { setInputs({ ...inputs, [field.key]: event.target.value }); setSuccess(false); setError('') }} /><span>{field.unit}</span></div>
        <small id={`${field.key}-range`}>De {field.min} a {field.max} {field.unit}</small>
      </div>)}</div>
      <div className="admin-form-actions"><button className="button" type="submit" disabled={saving}><Save size={16} /> {saving ? 'Salvando...' : 'Salvar configurações'}</button></div>
    </form>}
  </div>
}
