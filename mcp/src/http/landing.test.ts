import { describe, expect, it } from 'vitest'
import { renderAdvisoryText } from './landing.js'

describe('advisory HTML rendering', () => {
  it('renders Markdown headings, blockquotes, fenced code and tables', () => {
    const html = renderAdvisoryText(
      '## Example\n\n> *Note*\n\n```sh\necho hello\n```\n\n| Key | Value |\n| --- | --- |\n| a | b |'
    )

    expect(html).toContain('<h2>Example</h2>')
    expect(html).toContain('<blockquote>\n<p><em>Note</em></p>')
    expect(html).toContain('<pre><code class="language-sh">echo hello\n</code></pre>')
    expect(html).toContain('<table>')
    expect(html).toContain('<td>b</td>')
  })

  it('renders HTTP links while keeping unsafe schemes and code inert', () => {
    expect(renderAdvisoryText('[Issue](https://github.com/microsoft/vscode/issues/141169)')).toBe(
      '<p><a href="https://github.com/microsoft/vscode/issues/141169">Issue</a></p>'
    )
    expect(renderAdvisoryText('[Bad](javascript:alert) `[Code](https://example.com)`')).toBe(
      '<p>Bad <code>[Code](https://example.com)</code></p>'
    )
  })

  it('links bundled advisory references while leaving other code literal', () => {
    expect(renderAdvisoryText('See `deploying/networking`; use `foo/bar`.')).toBe(
      '<p>See <a href="#deploying/networking"><code>deploying/networking</code></a>; use <code>foo/bar</code>.</p>'
    )
  })

  it('renders paragraphs, lists, emphasis and literal inline code', () => {
    expect(
      renderAdvisoryText('First paragraph.\n\n- **Explicit** settings\n- Use `a < b`\n\nTODO: More.')
    ).toBe(
      '<p>First paragraph.</p>\n<ul>\n<li><strong>Explicit</strong> settings</li>\n<li>Use <code>a &lt; b</code></li>\n</ul>\n<p>TODO: More.</p>'
    )
  })

  it('escapes source HTML and keeps code literal', () => {
    expect(renderAdvisoryText('Text <script>alert("x")</script> `**literal**`')).toBe(
      '<p>Text &lt;script&gt;alert("x")&lt;/script&gt; <code>**literal**</code></p>'
    )
  })
})
