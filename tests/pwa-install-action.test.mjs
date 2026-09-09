// Sprint PWA — Bloco 2 (instalação pelo rodapé). Validação por código-fonte
// (sem DOM/jsdom — mesmo padrão já usado nos demais testes deste projeto),
// focada nos pontos de segurança pedidos: preventDefault no
// beforeinstallprompt, listeners removidos no cleanup, evento capturado
// limpo após o uso, e os textos exatos por cenário.
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'

const hookSrc = readFileSync(new URL('../src/hooks/usePwaInstallAction.ts', import.meta.url), 'utf8')
const footerSrc = readFileSync(new URL('../src/components/Footer.tsx', import.meta.url), 'utf8')

test('beforeinstallprompt: preventDefault é chamado (impede o mini-infobar automático do Chrome) antes de guardar o evento', () => {
  const body = hookSrc.match(/const handleBeforeInstallPrompt = \(event: Event\) => \{([\s\S]*?)\n {4}\}/)?.[0] ?? ''
  assert.ok(body, 'handleBeforeInstallPrompt não encontrado')
  const preventIndex = body.indexOf('event.preventDefault()')
  const setIndex = body.indexOf('setDeferredEvent(event as BeforeInstallPromptEvent)')
  assert.ok(preventIndex >= 0 && setIndex > preventIndex, 'preventDefault precisa vir antes de guardar o evento')
})

test('listeners de beforeinstallprompt/appinstalled são removidos no cleanup do useEffect (nunca vazam entre montagens)', () => {
  const effectBody = hookSrc.match(/useEffect\(\(\) => \{([\s\S]*?)\n {2}\}, \[\]\)/)?.[0] ?? ''
  assert.ok(effectBody, 'useEffect de registro dos listeners não encontrado')
  assert.match(effectBody, /window\.addEventListener\('beforeinstallprompt', handleBeforeInstallPrompt\)/)
  assert.match(effectBody, /window\.addEventListener\('appinstalled', handleAppInstalled\)/)
  const cleanup = effectBody.match(/return \(\) => \{([\s\S]*?)\}/)?.[0] ?? ''
  assert.match(cleanup, /window\.removeEventListener\('beforeinstallprompt', handleBeforeInstallPrompt\)/)
  assert.match(cleanup, /window\.removeEventListener\('appinstalled', handleAppInstalled\)/)
})

test('install(): chama prompt(), aguarda userChoice, e sempre limpa o evento capturado depois (aceito ou recusado — não pode ser reusado)', () => {
  const body = hookSrc.match(/const install = useCallback\(async \(\) => \{([\s\S]*?)\n {2}\}, \[deferredEvent\]\)/)?.[0] ?? ''
  assert.ok(body, 'install não encontrado')
  assert.match(body, /await deferredEvent\.prompt\(\)/)
  assert.match(body, /const choice = await deferredEvent\.userChoice/)
  const promptIndex = body.indexOf('await deferredEvent.prompt()')
  const clearIndex = body.indexOf('setDeferredEvent(null)')
  assert.ok(promptIndex >= 0 && clearIndex > promptIndex, 'o evento só pode ser limpo depois de usado, nunca antes')
})

test('appinstalled: marca instalado e limpa qualquer evento pendente — ação deixa de ser oferecida', () => {
  const body = hookSrc.match(/const handleAppInstalled = \(\) => \{([\s\S]*?)\n {4}\}/)?.[0] ?? ''
  assert.ok(body, 'handleAppInstalled não encontrado')
  assert.match(body, /setInstalled\(true\)/)
  assert.match(body, /setDeferredEvent\(null\)/)
})

test('já instalado/standalone (display-mode ou navigator.standalone) nunca oferece nenhuma ação — cenário 3', () => {
  assert.match(hookSrc, /window\.matchMedia\('\(display-mode: standalone\)'\)\.matches \|\| nav\.standalone === true/)
  assert.match(hookSrc, /if \(installed\) return \{ kind: 'none' \}/)
})

test('rótulos exatos por cenário: Android/celular, desktop/computador, iOS', () => {
  assert.match(hookSrc, /'Instalar GiroMicro neste celular'/)
  assert.match(hookSrc, /'Instalar GiroMicro neste computador'/)
  assert.match(hookSrc, /'Como instalar o GiroMicro'/)
})

test('sem beforeinstallprompt e sem iOS: nenhuma ação (cenário 5 — nunca mostra opção inútil)', () => {
  assert.match(hookSrc, /if \(isIOSDevice\(\)\) return \{ kind: 'ios-instructions', label: 'Como instalar o GiroMicro' \}\s*\n\s*return \{ kind: 'none' \}/)
})

test('rodapé: instrução exata do iOS, e o botão de prompt chama installAction.install() diretamente (sem lógica duplicada)', () => {
  assert.match(footerSrc, /No Safari, toque em Compartilhar e depois em Adicionar à Tela de Início\./)
  assert.match(footerSrc, /onClick=\{\(\) => void installAction\.install\(\)\}/)
  assert.match(footerSrc, /import \{ usePwaInstallAction \} from '\.\.\/hooks\/usePwaInstallAction'/)
})
