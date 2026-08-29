type LegalPageVariant = 'privacidade' | 'termos'

interface LegalPageProps {
  variant: LegalPageVariant
  onBackToHome: () => void
}

const privacySections = [
  {
    title: '1. Dados que podemos coletar',
    paragraphs: [
      'Podemos tratar dados pessoais e informações fornecidas pelo usuário, incluindo nome e e-mail obtidos por meio do login com Google; identificador da conta; informações cadastradas sobre seu negócio ou atividade profissional; dados de contato; endereço comercial; descrição; imagens; produtos, serviços, projetos ou outros conteúdos inseridos voluntariamente na plataforma; e informações técnicas básicas necessárias ao funcionamento e à segurança do serviço.',
    ],
  },
  {
    title: '2. Login com Google',
    paragraphs: [
      'A autenticação pode ser realizada por meio do Google. O GiroMicro não recebe nem armazena a senha da conta Google. A autenticação é processada através dos serviços utilizados pela plataforma. Atualmente, o Supabase é utilizado como infraestrutura de autenticação e o acesso concedido deve ficar limitado às informações necessárias para identificação e autenticação do usuário.',
    ],
  },
  {
    title: '3. Como utilizamos os dados',
    paragraphs: [
      'Os dados podem ser utilizados para autenticar usuários, disponibilizar e administrar páginas criadas na plataforma, salvar e exibir informações cadastradas pelo próprio usuário, enviar comunicações operacionais relacionadas ao serviço, melhorar estabilidade, segurança e funcionamento da plataforma e cumprir obrigações legais quando aplicável.',
    ],
  },
  {
    title: '4. Conteúdo público',
    paragraphs: [
      'Determinadas informações cadastradas pelo usuário podem ser publicadas intencionalmente em sua página pública, incluindo nome do negócio ou profissional, descrição, endereço quando o usuário optar por exibí-lo, meios de contato, imagens, produtos, serviços, projetos e outros conteúdos inseridos para divulgação. O próprio usuário é responsável pelas informações que decide tornar públicas.',
    ],
  },
  {
    title: '5. Compartilhamento de dados',
    paragraphs: [
      'O GiroMicro não vende dados pessoais. Dados podem ser processados por prestadores de infraestrutura necessários ao funcionamento da plataforma, incluindo serviços de hospedagem, banco de dados, armazenamento, autenticação e envio de e-mails, sempre dentro da finalidade necessária à operação do serviço.',
    ],
  },
  {
    title: '6. Segurança',
    paragraphs: [
      'São adotadas medidas técnicas e organizacionais razoáveis para proteção dos dados. Ainda assim, nenhum serviço online pode garantir segurança absoluta.',
    ],
  },
  {
    title: '7. Retenção e exclusão',
    paragraphs: [
      'Os dados podem ser mantidos enquanto a conta estiver ativa. Determinados dados poderão ser mantidos quando necessários ao funcionamento do serviço ou cumprimento de obrigações legais. O usuário poderá solicitar correção ou exclusão de dados, observadas limitações técnicas ou legais aplicáveis.',
    ],
  },
  {
    title: '8. Direitos do titular',
    paragraphs: [
      'O GiroMicro respeita os direitos previstos na Lei Geral de Proteção de Dados Pessoais — LGPD (Lei nº 13.709/2018). Quando aplicável, o usuário pode solicitar confirmação da existência de tratamento, acesso, correção, informação, exclusão e demais direitos previstos na legislação.',
    ],
  },
  {
    title: '9. Serviços de terceiros',
    paragraphs: [
      'A plataforma utiliza serviços de terceiros, incluindo Google para autenticação, Supabase para serviços de infraestrutura, autenticação e dados, e outros fornecedores necessários à operação da plataforma. Esses fornecedores possuem suas próprias políticas e práticas de privacidade.',
    ],
  },
  {
    title: '10. Alterações desta política',
    paragraphs: [
      'A política poderá ser atualizada conforme a evolução do GiroMicro, mudanças operacionais ou exigências legais. A versão publicada nesta página será considerada a versão vigente.',
    ],
  },
  {
    title: '11. Contato',
    paragraphs: [
      'Para assuntos relacionados à privacidade ou aos seus dados pessoais, entre em contato pelos canais oficiais disponibilizados pelo GiroMicro.',
    ],
  },
]

const termsSections = [
  {
    title: '1. Sobre o GiroMicro',
    paragraphs: [
      'O GiroMicro é uma plataforma destinada a auxiliar pequenos negócios e profissionais na criação de presença digital e, conforme os recursos disponibilizados, em atividades simples de gestão.',
    ],
  },
  {
    title: '2. Cadastro e acesso',
    paragraphs: [
      'O usuário é responsável pelas informações fornecidas, o acesso pode utilizar autenticação via Google, o usuário é responsável por manter sua conta e dispositivo seguros e o uso da conta deve ser pessoal e legítimo.',
    ],
  },
  {
    title: '3. Conteúdo cadastrado pelo usuário',
    paragraphs: [
      'O usuário é responsável por textos, imagens, informações comerciais, contatos, produtos, serviços, projetos e demais conteúdos publicados através de sua conta. O usuário deve possuir autorização ou direitos necessários para utilizar os conteúdos enviados à plataforma.',
    ],
  },
  {
    title: '4. Uso adequado',
    paragraphs: [
      'É proibido utilizar o GiroMicro para atividades ilegais, fraude, violação de direitos de terceiros, publicação de conteúdo ilícito, tentativa de invasão, abuso da infraestrutura, comprometimento da segurança da plataforma ou utilização que possa prejudicar outros usuários ou o serviço.',
    ],
  },
  {
    title: '5. Disponibilidade do serviço',
    paragraphs: [
      'Buscamos manter o serviço disponível e estável, porém podem ocorrer interrupções decorrentes de manutenção, atualizações, falhas técnicas, problemas de infraestrutura ou indisponibilidade de serviços de terceiros.',
    ],
  },
  {
    title: '6. Serviços de terceiros',
    paragraphs: [
      'A plataforma depende de serviços externos de infraestrutura, autenticação, hospedagem e comunicação. Indisponibilidades desses serviços podem afetar temporariamente o GiroMicro.',
    ],
  },
  {
    title: '7. Planos e funcionalidades',
    paragraphs: [
      'Funcionalidades, limites e condições dos planos podem evoluir; recursos gratuitos ou experimentais podem sofrer alterações; e novos recursos podem ser adicionados ao longo da evolução do produto.',
    ],
  },
  {
    title: '8. Suspensão de conta ou conteúdo',
    paragraphs: [
      'O GiroMicro poderá suspender ou restringir contas ou conteúdos em situações como violação destes termos, atividade ilegal, fraude, risco à segurança ou utilização abusiva da plataforma.',
    ],
  },
  {
    title: '9. Responsabilidade do usuário',
    paragraphs: [
      'O usuário é responsável pela veracidade das informações comerciais disponibilizadas em sua página e pelo relacionamento com seus próprios clientes. O GiroMicro não participa diretamente das transações comerciais realizadas entre usuários da plataforma e seus clientes, salvo quando algum recurso específico informar expressamente o contrário.',
    ],
  },
  {
    title: '10. Limitação de responsabilidade',
    paragraphs: [
      'Buscamos confiabilidade e segurança, mas não existe garantia de funcionamento absolutamente ininterrupto. Podem ocorrer falhas técnicas. O GiroMicro não deve ser responsabilizado por informações incorretas inseridas pelo próprio usuário, e serviços externos fora do controle da plataforma podem causar indisponibilidades.',
    ],
  },
  {
    title: '11. Alterações dos termos',
    paragraphs: [
      'Os termos poderão ser atualizados conforme evolução do produto, mudanças operacionais ou exigências legais. A versão publicada na plataforma será considerada vigente.',
    ],
  },
  {
    title: '12. Contato',
    paragraphs: [
      'Para dúvidas relacionadas aos Termos de Uso, utilize os canais oficiais disponibilizados pelo GiroMicro.',
    ],
  },
]

export function LegalPage({ variant, onBackToHome }: LegalPageProps) {
  const isPrivacy = variant === 'privacidade'
  const title = isPrivacy ? 'Política de Privacidade — GiroMicro' : 'Termos de Uso — GiroMicro'
  const intro = isPrivacy
    ? 'O GiroMicro valoriza a privacidade dos usuários e trata dados pessoais de forma responsável, transparente e segura. Esta Política de Privacidade explica quais informações podem ser coletadas, como são utilizadas e quais são os direitos dos usuários.'
    : 'Estes Termos de Uso estabelecem as condições para utilização da plataforma GiroMicro. Ao acessar ou utilizar o serviço, o usuário declara estar de acordo com estas condições.'

  const sections = isPrivacy ? privacySections : termsSections

  return (
    <main className="legal-page">
      <div className="container legal-shell">
        <article className="legal-card">
          <header className="legal-header">
            <p className="eyebrow centered-eyebrow">GiroMicro</p>
            <h1>{title}</h1>
            <p className="legal-intro">{intro}</p>
          </header>

          <div className="legal-content">
            {sections.map((section) => (
              <section className="legal-section" key={section.title}>
                <h2>{section.title}</h2>

                {section.paragraphs.map((paragraph, index) => (
                  <p key={`${section.title}-p-${index}`}>{paragraph}</p>
                ))}
              </section>
            ))}
          </div>

          <div className="legal-actions">
            <button className="button" onClick={onBackToHome}>Voltar para a Home</button>

            <div className="legal-links">
              <a href="#/privacidade">Política de Privacidade</a>
              <a href="#/termos">Termos de Uso</a>
            </div>
          </div>

          <p className="legal-updated">Última atualização: 29 de agosto de 2026.</p>
        </article>
      </div>
    </main>
  )
}
