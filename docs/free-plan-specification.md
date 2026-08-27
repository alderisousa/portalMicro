# PortalMicro — especificação funcional do plano Free

## Status do documento

Este documento é a especificação funcional oficial do plano Free do PortalMicro.

O comportamento registrado no baseline descreve somente o estado atual do protótipo e não determina as regras de negócio. Quando houver divergência entre o comportamento atual, o baseline e esta especificação, este documento deve ser considerado a regra desejada do PortalMicro.

As regras aqui descritas ainda não representam funcionalidades implementadas. Sua implementação deverá ocorrer incrementalmente nas próximas etapas da migração.

## Objetivo do PortalMicro

Permitir que microempreendedores, profissionais, prestadores de serviços e pequenos comércios criem uma página profissional de presença digital de forma simples, sem precisar conhecer desenvolvimento de sites.

## Fluxo oficial

O fluxo principal do usuário será:

```text
Home → Comece grátis → Login Google → Dashboard → Wizard → Preview → Publicar → Página pública
```

### Descrição do fluxo

1. O visitante acessa a home do PortalMicro.
2. Seleciona a ação “Comece grátis”.
3. Autentica-se com sua conta Google.
4. Acessa seu dashboard.
5. Cria ou edita uma página por meio do wizard.
6. Visualiza a prévia antes da publicação.
7. Publica a página.
8. A página passa a estar disponível em uma URL pública baseada em slug.

## Regras gerais do plano Free

- O plano Free permitirá inicialmente uma página publicada por conta.
- O limite de uma página publicada é uma regra comercial do plano, não uma restrição estrutural do banco de dados.
- Um usuário poderá possuir vários negócios no modelo de dados.
- A quantidade de páginas que poderão ser publicadas será controlada pelas regras do plano associado à conta.
- A coluna `businesses.owner_id` não deverá possuir restrição `UNIQUE`.
- A relação desejada entre usuário e negócio é de um para muitos.
- Negócios adicionais poderão existir como rascunhos ou conforme regras futuras do produto.
- A estrutura deverá permitir a criação futura de outros planos e limites sem exigir a remodelagem da relação entre usuários e negócios.

## Wizard oficial do plano Free

O wizard será composto por seis etapas, na ordem definida abaixo.

### 1. Identidade

Campos e funcionalidades:

- Nome fantasia.
- Upload de logo.

O nome fantasia identifica publicamente o negócio. A logo é opcional, mas poderá ser exibida na página pública quando fornecida.

### 2. Sobre o negócio

Campos e funcionalidades:

- Texto em que o usuário descreve sua empresa, comércio, atividade ou serviço.

Esse conteúdo será apresentado na página pública como a descrição institucional do negócio.

### 3. Tipo de atendimento

Opções disponíveis:

- Físico.
- Online.
- Ambos.

O usuário deverá poder indicar se atende em um endereço físico, pela internet ou nas duas modalidades.

### 4. Endereço

Campos e funcionalidades:

- CEP.
- Consulta automática via ViaCEP.
- Logradouro.
- Bairro.
- Cidade.
- UF.
- Número.
- Complemento.
- Opção para exibir ou ocultar o endereço quando aplicável.

A consulta do ViaCEP deverá auxiliar o preenchimento sem impedir correções manuais. A exibição pública do endereço deverá respeitar a escolha do proprietário e o tipo de atendimento informado.

### 5. Vitrine de produtos e serviços

Regras e funcionalidades:

- O plano Free permitirá no máximo 5 itens na vitrine.
- Cada item deverá possuir:
  - imagem/foto;
  - título/nome;
  - breve descrição.
- Preço não fará parte do MVP neste momento.
- A ordem dos itens deverá ser preservada para exibição na página.
- O limite de 5 itens é uma regra comercial do plano Free e não uma limitação estrutural do banco de dados nem do Supabase Storage.

A estrutura de dados deverá permitir que planos futuros ofereçam limites maiores sem exigir a criação de outro bucket ou uma alteração estrutural dos registros da vitrine.

### 6. Contato

Campos:

- E-mail.
- Telefone/WhatsApp.

Esses dados poderão ser apresentados como formas de contato na página pública.

## Preview

Ao concluir ou durante a edição do cadastro, o proprietário poderá visualizar uma prévia da página.

A prévia deverá permitir a conferência das informações antes da publicação, incluindo:

- identidade;
- descrição do negócio;
- tipo de atendimento;
- endereço, quando configurado para exibição;
- itens da vitrine, com imagem, título e descrição;
- informações de contato.

A prévia, por si só, não deverá tornar um rascunho publicamente acessível.

## Publicação

- Ao concluir o cadastro, o usuário poderá publicar sua página a partir da prévia ou do dashboard.
- A publicação deverá persistir o estado publicado no banco de dados.
- A página publicada deverá possuir uma URL pública baseada em slug.
- O slug deverá identificar o negócio de maneira única entre as páginas públicas.
- A página pública deverá continuar acessível após recarregar o navegador ou abrir a URL em outro dispositivo.
- O proprietário poderá editar posteriormente as informações do negócio.
- Alterações em uma página já publicada poderão ser enviadas por uma ação de atualização da página publicada.
- O plano Free permitirá inicialmente apenas uma página publicada por conta, mesmo que o usuário possua vários negócios no banco.

## Modelo de propriedade esperado

O modelo deverá representar a seguinte relação:

```text
auth.users
    1
    │
    └── N businesses
```

Consequentemente:

- `businesses.owner_id` deverá ser uma chave estrangeira para o usuário proprietário;
- `businesses.owner_id` deverá ser indexada para consultas, mas não deverá ser única;
- a autorização deverá garantir que somente o proprietário possa criar ou alterar seus negócios;
- a leitura pública deverá ser permitida apenas para páginas efetivamente publicadas;
- o limite de publicação deverá ser validado separadamente das permissões estruturais de propriedade.

## Limites como regras de plano

Os seguintes limites pertencem ao plano Free:

- uma página publicada por conta;
- cinco itens de vitrine por negócio/página no plano Free.

Esses limites não devem ser codificados como limitações permanentes da estrutura de banco ou Storage. A solução deverá permitir que planos futuros aumentem esses valores.

O local definitivo para representar e aplicar os planos será definido durante o desenho do banco e das regras de autorização. Até essa definição, nenhuma restrição `UNIQUE` em `businesses.owner_id` deverá ser criada para simular o limite do plano Free.

## Requisito futuro de categoria e área de atuação

- O negócio deverá possuir categoria ou área de atuação no modelo de dados.
- Não é necessário definir neste momento uma etapa exclusiva do wizard para coletar essa informação.
- A informação será utilizada futuramente para classificação, pesquisa e descoberta de negócios dentro do PortalMicro.
- Nenhuma funcionalidade de busca, categorias, filtros ou descoberta deverá ser implementada nesta etapa.

O modelo deverá preservar a possibilidade de adicionar essa classificação sem vincular sua existência à ordem atual das etapas do wizard.

## Divergências em relação ao comportamento atual

- O sistema atual trata as fotos como uma galeria.
- O modelo desejado trata esses registros como itens de uma vitrine de produtos e serviços.
- Atualmente, cada foto possui somente imagem e descrição.
- O novo modelo deverá suportar imagem, título e descrição para cada item.
- Atualmente, o código permite até 10 fotos.
- O plano Free permitirá até 5 itens de vitrine.
- A área de atuação existe no protótipo como uma etapa do wizard; a especificação mantém essa informação como requisito futuro de modelagem, sem exigir agora uma etapa exclusiva.

## Fora do escopo deste documento

Este documento não define ainda:

- preços de planos futuros;
- quantidade de negócios que podem permanecer como rascunho;
- domínio personalizado;
- recursos de comércio eletrônico;
- métricas e analytics da página;
- duração ou retenção de arquivos;
- moderação de conteúdo;
- formatos e tamanhos exatos permitidos para imagens;
- estratégia técnica definitiva para aplicação dos limites do plano.

Esses pontos deverão receber especificações próprias antes da implementação correspondente.
