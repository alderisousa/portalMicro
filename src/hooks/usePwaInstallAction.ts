import { useCallback, useEffect, useState } from 'react'

// `beforeinstallprompt`/BeforeInstallPromptEvent não fazem parte do lib.dom.d.ts
// do TypeScript (é uma extensão não-padrão, hoje só em navegadores Chromium) —
// tipamos manualmente em vez de usar `any`.
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[]
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
  prompt(): Promise<void>
}

// `navigator.userAgentData`/`navigator.standalone` também não estão no
// lib.dom.d.ts padrão (userAgentData é Chromium-only; standalone é iOS
// Safari-only) — extensões pontuais do tipo Navigator, sem `any`.
type NavigatorWithPwaExtensions = Navigator & {
  userAgentData?: { mobile?: boolean }
  standalone?: boolean
}

function isStandaloneDisplay(): boolean {
  const nav = navigator as NavigatorWithPwaExtensions
  return window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true
}

function isIOSDevice(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !('MSStream' in window)
}

function isMobileDevice(): boolean {
  const nav = navigator as NavigatorWithPwaExtensions
  if (typeof nav.userAgentData?.mobile === 'boolean') return nav.userAgentData.mobile
  return /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent)
}

export type PwaInstallAction =
  // Já instalado/standalone, ou navegador sem suporte conhecido e não-iOS:
  // nenhuma ação a oferecer (cenário 3 e 5).
  | { kind: 'none' }
  // beforeinstallprompt disponível (Android ou desktop) — cenários 1 e 2.
  | { kind: 'prompt'; label: string; install: () => Promise<void> }
  // iOS/Safari sem prompt programático — cenário 4.
  | { kind: 'ios-instructions'; label: string }

// Hook pequeno e reutilizável: só decide QUAL ação (se houver) oferecer no
// rodapé, sem nenhum JSX/UI — quem chama decide como renderizar.
export function usePwaInstallAction(): PwaInstallAction {
  const [deferredEvent, setDeferredEvent] = useState<BeforeInstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(isStandaloneDisplay)

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      // Impede o mini-infobar automático do Chrome — a instalação passa a
      // ser oferecida só pela ação do rodapé.
      event.preventDefault()
      setDeferredEvent(event as BeforeInstallPromptEvent)
    }
    const handleAppInstalled = () => {
      setInstalled(true)
      setDeferredEvent(null)
    }

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
    window.addEventListener('appinstalled', handleAppInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
      window.removeEventListener('appinstalled', handleAppInstalled)
    }
  }, [])

  const install = useCallback(async () => {
    if (!deferredEvent) return
    await deferredEvent.prompt()
    const choice = await deferredEvent.userChoice
    if (choice.outcome === 'accepted') setInstalled(true)
    // O evento capturado só pode ser usado uma vez (aceito ou recusado) —
    // limpa aqui para não tentar reusar um prompt já consumido.
    setDeferredEvent(null)
  }, [deferredEvent])

  if (installed) return { kind: 'none' }
  if (deferredEvent) {
    return {
      kind: 'prompt',
      label: isMobileDevice() ? 'Instalar GiroMicro neste celular' : 'Instalar GiroMicro neste computador',
      install,
    }
  }
  if (isIOSDevice()) return { kind: 'ios-instructions', label: 'Como instalar o GiroMicro' }
  return { kind: 'none' }
}
