import { marked } from 'marked'
import DOMPurify from 'dompurify'

/** Render descriptions without allowing executable markup or embedded resources. */
export function renderMarkdown(target: HTMLElement, description: string): void {
  const fragment = DOMPurify.sanitize(marked.parse(description, { async: false }), {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: [
      'p',
      'br',
      'strong',
      'em',
      'del',
      'a',
      'code',
      'pre',
      'blockquote',
      'ul',
      'ol',
      'li',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'hr',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td'
    ],
    ALLOWED_ATTR: ['href', 'title', 'start'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false
  })

  for (const link of fragment.querySelectorAll('a[href]')) {
    try {
      const url = new URL(link.getAttribute('href')!, document.baseURI)

      if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) link.removeAttribute('href')
      else {
        link.setAttribute('target', '_blank')
        link.setAttribute('rel', 'noopener noreferrer')
      }
    } catch {
      link.removeAttribute('href')
    }
  }

  target.classList.add('markdown')
  target.replaceChildren(fragment)
}
