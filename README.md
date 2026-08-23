# Portal Micro

Protótipo de presença digital para microempreendedores de Itanhém.

## Executar

```bash
npm install
npm run prototype
```

O frontend fica em `http://localhost:5173` e a API em `http://localhost:4000`.

## Funcionalidades do protótipo

- Cadastro guiado em seis etapas
- Modo demonstração local
- Salvamento do perfil em `data/clients/{empresa}/data.json`
- Upload de até 10 fotos na pasta do cliente
- Preview e publicação local por URL
- Formatação de títulos, listas, negrito e itálico no texto do negócio
- Estrutura preparada para autenticação Google com Firebase

## Configuração do Firebase

Copie `.env.example` para `.env.local` e preencha as variáveis do projeto Firebase. O provedor Google também precisa ser ativado no Firebase Authentication.
