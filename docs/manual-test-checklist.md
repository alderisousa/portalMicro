# PortalMicro — checklist manual do baseline

Use este checklist antes de iniciar a migração e repita-o após cada etapa. Registre navegador, tamanho da janela, conta utilizada, resultado observado e evidências de qualquer falha.

## Preparação

- [ ] Confirmar que as dependências estão instaladas.
- [ ] Confirmar quais variáveis existem em `.env.local`, sem copiar valores secretos para o relatório.
- [ ] Registrar se o servidor Express está ligado ou desligado em cada cenário.
- [ ] Abrir o DevTools e observar erros no Console e requisições na aba Network.
- [ ] Usar uma conta e um negócio exclusivos para o teste, evitando alterar dados importantes.

## Abertura da home

- [ ] Executar o frontend e abrir a URL local do Vite.
- [ ] Confirmar que a home renderiza sem tela branca.
- [ ] Confirmar logo, navegação, textos, botões e seções principais.
- [ ] Confirmar que “Como funciona” navega para a seção correta.
- [ ] Confirmar que a lista de clientes aparece quando a API Express está disponível e contém clientes publicados.
- [ ] Verificar Console e Network em busca de erros inesperados.

## Login Google

- [ ] Clicar em “Entrar” ou “Criar minha página”.
- [ ] Acionar o login Google.
- [ ] Confirmar abertura ou redirecionamento para o Google.
- [ ] Concluir o login com uma conta de teste.
- [ ] Confirmar retorno para a origem correta da aplicação.
- [ ] Confirmar que nome ou e-mail do usuário aparece conforme esperado.
- [ ] Recarregar a página e confirmar restauração da sessão Supabase.
- [ ] Registrar erros de callback, redirect ou provider no Console/Network.

## Modo demonstração

- [ ] Sair de qualquer sessão Google antes do teste.
- [ ] Entrar pelo modo demonstração.
- [ ] Confirmar acesso ao dashboard.
- [ ] Confirmar que `portalmicro-session` foi criado no `localStorage`.
- [ ] Recarregar e observar se o modo demonstração é restaurado.
- [ ] Confirmar se o modo demonstração permite visualizar, editar e publicar; registrar o comportamento atual, mesmo que inseguro.

## Dashboard

- [ ] Confirmar saudação e nome da conta.
- [ ] Confirmar nome do negócio ou texto padrão.
- [ ] Confirmar indicador de rascunho/publicado.
- [ ] Confirmar percentual de progresso.
- [ ] Confirmar funcionamento de “Começar meu site” ou “Continuar criação”.
- [ ] Confirmar funcionamento de “Visualizar”.
- [ ] Confirmar presença da mensagem de salvamento local.

## Wizard — etapa 1: atuação

- [ ] Abrir a primeira etapa.
- [ ] Preencher a área de atuação.
- [ ] Avançar e voltar, confirmando preservação do valor.
- [ ] Recarregar a página e confirmar o comportamento de persistência.

## Wizard — etapa 2: identidade

- [ ] Preencher o nome fantasia.
- [ ] Selecionar uma logo válida.
- [ ] Confirmar preview da logo.
- [ ] Avançar e voltar, confirmando preservação do nome e da imagem.

## Wizard — etapa 3: local

- [ ] Selecionar atendimento físico.
- [ ] Selecionar atendimento online.
- [ ] Selecionar ambos.
- [ ] Confirmar o comportamento ao desmarcar cada opção.
- [ ] Preencher número, complemento e demais campos de endereço.
- [ ] Alternar a opção de exibir ou ocultar endereço.
- [ ] Confirmar o endereço formatado no preview.

## Consulta de CEP

- [ ] Informar um CEP válido com oito dígitos.
- [ ] Acionar a consulta.
- [ ] Confirmar preenchimento de rua, bairro, cidade e UF.
- [ ] Testar CEP formatado com hífen.
- [ ] Testar CEP inexistente.
- [ ] Testar valor com menos de oito dígitos.
- [ ] Testar com a rede indisponível.
- [ ] Confirmar mensagem e término do estado de carregamento em caso de erro.

## Wizard — etapa 4: história

- [ ] Preencher uma descrição simples.
- [ ] Testar parágrafos em múltiplas linhas.
- [ ] Testar títulos com `#`, `##` e `###`.
- [ ] Testar listas com hífen ou asterisco.
- [ ] Testar negrito com `**texto**` e itálico com `*texto*`.
- [ ] Confirmar renderização no preview sem exibir marcação indevida.

## Wizard — etapa 5: fotos

- [ ] Adicionar uma foto.
- [ ] Adicionar várias fotos de uma vez.
- [ ] Confirmar limite total de dez fotos.
- [ ] Preencher e editar a descrição de cada foto.
- [ ] Remover uma foto.
- [ ] Avançar e voltar, confirmando preservação.

## Wizard — etapa 6: contato

- [ ] Preencher WhatsApp.
- [ ] Preencher e-mail.
- [ ] Confirmar exibição correta no preview.
- [ ] Confirmar se os links de contato gerados funcionam.
- [ ] Concluir a sexta etapa e confirmar progresso de 100%.

## Upload de logo

- [ ] Enviar imagem JPG ou PNG válida.
- [ ] Confirmar requisição ao Cloudinary e retorno de uma URL HTTPS.
- [ ] Confirmar que a logo permanece após recarregar a página quando o upload Cloudinary funciona.
- [ ] Simular falha do Cloudinary e confirmar uso do preview temporário local.
- [ ] Após o fallback local, recarregar e registrar que a URL temporária pode deixar de funcionar.
- [ ] Testar arquivo não-imagem e observar validação existente.
- [ ] Testar imagem grande e registrar comportamento.

## Upload de fotos

- [ ] Enviar uma foto válida.
- [ ] Enviar várias fotos válidas.
- [ ] Confirmar que as URLs retornadas pertencem ao Cloudinary.
- [ ] Confirmar descrições e remoção das fotos.
- [ ] Simular falha do Cloudinary e observar o fallback com URL temporária.
- [ ] Recarregar após o fallback e registrar o resultado.
- [ ] Confirmar que a interface não permite ultrapassar dez fotos.

## Preview

- [ ] Abrir o preview a partir do dashboard.
- [ ] Confirmar nome, área, logo, história, fotos, endereço e contatos.
- [ ] Confirmar diferença entre “Prévia privada” e “Site público”.
- [ ] Confirmar que endereço oculto não é exibido.
- [ ] Confirmar que o proprietário visualiza os controles de edição esperados.
- [ ] Testar preview com campos ainda vazios.

## Publicação

- [ ] Publicar um negócio preenchido.
- [ ] Confirmar alteração do status para público.
- [ ] Confirmar geração de slug e URL pública.
- [ ] Confirmar atualização da barra de endereço.
- [ ] Copiar a URL gerada para registro.
- [ ] Atualizar um negócio já publicado e usar “Atualizar site público”.
- [ ] Observar no Network se a publicação efetua alguma gravação no servidor.

## Acesso ao site publicado

- [ ] Abrir a URL pública na mesma aba.
- [ ] Abrir a URL pública em nova aba.
- [ ] Abrir a URL em janela anônima.
- [ ] Recarregar a URL pública diretamente.
- [ ] Confirmar se o conteúdo continua disponível depois do reload.
- [ ] Testar slug existente.
- [ ] Testar slug inexistente e registrar a experiência exibida ao usuário.
- [ ] Confirmar que visitante não vê controles exclusivos do proprietário.
- [ ] Confirmar se o site aparece na lista de clientes publicados da home.

## Logout

- [ ] Fazer logout pelo dashboard ou navegação.
- [ ] Confirmar encerramento da sessão Supabase.
- [ ] Confirmar remoção da chave de sessão demonstrativa.
- [ ] Confirmar retorno para a home.
- [ ] Tentar voltar pelo navegador e verificar se áreas privadas reaparecem.
- [ ] Recarregar e confirmar que o usuário permanece desconectado.

## Recarregar página

- [ ] Recarregar durante cada etapa do wizard.
- [ ] Recarregar no dashboard.
- [ ] Recarregar no preview privado.
- [ ] Recarregar no site público.
- [ ] Recarregar após login Google.
- [ ] Recarregar após login demonstração.
- [ ] Confirmar quais dados vêm do `localStorage` e quais vêm da API.
- [ ] Testar voltar e avançar após mudanças feitas com `history.pushState`.

## Responsividade

- [ ] Testar desktop com largura igual ou superior a 1280 px.
- [ ] Testar tablet próximo de 768 px.
- [ ] Testar celular próximo de 375 px.
- [ ] Abrir e fechar o menu móvel.
- [ ] Confirmar que botões, inputs e textos não transbordam.
- [ ] Confirmar navegação horizontal do stepper do wizard.
- [ ] Confirmar visualização das fotos e do endereço em tela pequena.
- [ ] Confirmar funcionamento com zoom do navegador em 200%.
- [ ] Confirmar navegação básica por teclado e foco visível.

## Comportamento com o servidor Express parado

- [ ] Encerrar o servidor Express e manter somente o Vite ativo.
- [ ] Abrir a home e confirmar se ela permanece utilizável.
- [ ] Observar a falha de `GET /api/clients` no Network.
- [ ] Confirmar se a lista pública desaparece sem quebrar a página.
- [ ] Testar login Google.
- [ ] Testar modo demonstração.
- [ ] Abrir dashboard e wizard.
- [ ] Confirmar que o salvamento em `localStorage` ainda funciona.
- [ ] Testar consulta de CEP, que depende de serviço externo e não do Express.
- [ ] Testar upload Cloudinary, que também não depende diretamente do Express.
- [ ] Publicar e observar se a prévia imediata funciona.
- [ ] Recarregar a URL `?site=slug` e registrar a falha de leitura da página pública.
- [ ] Confirmar se existe ou não uma mensagem visível para o usuário quando a API está indisponível.

## Registro do resultado

- [ ] Registrar data e hora do teste.
- [ ] Registrar commit ou estado do `git status` usado no teste.
- [ ] Registrar navegador e versão.
- [ ] Anexar capturas dos problemas encontrados.
- [ ] Classificar cada falha como preexistente ou regressão.
- [ ] Não avançar para a próxima etapa da migração enquanto houver regressão funcional sem decisão explícita.
