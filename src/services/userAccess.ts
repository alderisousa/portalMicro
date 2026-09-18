import { supabase } from '../lib/supabase'

export async function registerLastAccess(): Promise<void> {
  const { error } = await supabase.rpc('register_my_last_access')
  if (error) throw error
}

// Uma tentativa por usuario nesta inicializacao; reload cria um novo controle.
export function createAppAccessRecorder() {
  const recorded = new Set<string>()
  return (event: string, userId?: string) => {
    if (!userId || !['BOOTSTRAP', 'INITIAL_SESSION', 'SIGNED_IN'].includes(event) || recorded.has(userId)) return
    recorded.add(userId)
    // Fora do callback de Auth, que pode manter o lock da sessao.
    setTimeout(() => {
      void registerLastAccess().catch(error => console.error('Falha ao registrar ultimo acesso ao GiroMicro:', error))
    }, 0)
  }
}
