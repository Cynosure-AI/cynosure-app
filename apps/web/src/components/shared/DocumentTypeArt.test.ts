import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'
import { documentThumbnailHref, documentTypeStyle } from '../../utils/document-types'
import DocumentTypeArt from './DocumentTypeArt.vue'

const pdfHref = `/api/files?path=${encodeURIComponent('/tmp/q3 report.pdf')}&name=Report.pdf`

describe('documentTypeStyle', () => {
  test('groups extensions into families regardless of case or leading dot', () => {
    expect(documentTypeStyle('DOCX').name).toBe('Word')
    expect(documentTypeStyle('.odt').name).toBe('Word')
    expect(documentTypeStyle('xlsx').shape).toBe('table')
    expect(documentTypeStyle('pptx').shape).toBe('slide')
    expect(documentTypeStyle('unknown').name).toBe('Document')
  })
})

describe('documentThumbnailHref', () => {
  test('points PDFs served from /api/files at the thumbnail route', () => {
    expect(documentThumbnailHref(pdfHref, 'PDF')).toBe(`/api/files/thumbnail?path=${encodeURIComponent('/tmp/q3 report.pdf')}`)
  })

  test('skips formats without server rendering and foreign URLs', () => {
    expect(documentThumbnailHref('/api/files?path=%2Ftmp%2Fa.docx', 'docx')).toBeNull()
    expect(documentThumbnailHref('https://example.com/a.pdf', 'pdf')).toBeNull()
  })
})

describe('DocumentTypeArt', () => {
  test('layers the PDF thumbnail over the styled art and drops it if it fails', async () => {
    const wrapper = mount(DocumentTypeArt, {
      props: { ext: 'PDF', href: pdfHref },
      global: { stubs: { Icon: true } },
    })

    const image = wrapper.get('img')
    expect(image.attributes('src')).toBe(documentThumbnailHref(pdfHref, 'pdf'))
    expect(image.classes()).toContain('opacity-0')
    expect(wrapper.find('.doc-page').exists()).toBe(true)

    await image.trigger('error')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('.doc-page').exists()).toBe(true)
  })

  test('renders only the styled art for formats without thumbnails', () => {
    const wrapper = mount(DocumentTypeArt, {
      props: { ext: 'xlsx', href: '/api/files?path=%2Ftmp%2Fbudget.xlsx' },
      global: { stubs: { Icon: true } },
    })

    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.classes()).toContain('bg-emerald-500/10')
  })
})
