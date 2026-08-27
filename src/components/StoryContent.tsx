export function StoryContent({ story }: { story: string }) {
  const source = story || 'Sua história e o jeito especial de trabalhar aparecerão aqui.'
  const normalized = source
    .replace(/\s+(?=#{1,3}\s)/g, '\n\n')
    .replace(/\s+\*\s+(?=[A-ZÁÉÍÓÚÀÂÃÊÔÇ])/g, '\n- ')
  const blocks: { type: 'heading' | 'paragraph' | 'list'; level?: number; text?: string; items?: string[] }[] = []
  let paragraph: string[] = []
  let list: string[] = []
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', text: paragraph.join(' ') })
    if (list.length) blocks.push({ type: 'list', items: list })
    paragraph = []
    list = []
  }
  normalized.split(/\n/).forEach((line) => {
    const clean = line.trim()
    if (!clean) return flush()
    const heading = clean.match(/^(#{1,3})\s+(.+)$/)
    const bullet = clean.match(/^[-•*]\s+(.+)$/)
    if (heading) { flush(); blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] }) }
    else if (bullet) { if (paragraph.length) flush(); list.push(bullet[1]) }
    else { if (list.length) flush(); paragraph.push(clean) }
  })
  flush()
  return <div className="story-content">{blocks.map((block, index) => {
    if (block.type === 'heading') return block.level === 1 ? <h2 key={index}>{renderInline(block.text || '')}</h2> : <h3 key={index}>{renderInline(block.text || '')}</h3>
    if (block.type === 'list') return <ul key={index}>{block.items?.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}</ul>
    return <p key={index}>{renderInline(block.text || '')}</p>
  })}</div>
}

function renderInline(text: string) {
  return text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>
    if (part.startsWith('*') && part.endsWith('*')) return <em key={index}>{part.slice(1, -1)}</em>
    return part
  })
}

