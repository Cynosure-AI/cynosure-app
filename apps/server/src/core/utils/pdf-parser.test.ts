import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import AdmZip from 'adm-zip'
import { parseDocument } from './document-parser.js'
import { materializeFileAttachment } from '../artifacts/file-artifacts.js'

// Minimal real PDFs exercise the bundled PDF.js runtime, not a mocked extractor.
function makePdf(streams: string[], outline = false): Buffer {
    const outlineId = 4 + streams.length * 2
    const objects = [
        `<< /Type /Catalog /Pages 2 0 R ${outline ? `/Outlines ${outlineId} 0 R` : ''} >>`,
        `<< /Type /Pages /Kids [${streams.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${streams.length} >>`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ]
    streams.forEach((stream, i) => {
        objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`)
        objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)
    })
    if (outline) objects.push(
        `<< /Type /Outlines /First ${outlineId + 1} 0 R /Last ${outlineId + 1} 0 R /Count 2 >>`,
        `<< /Title (Overview) /Parent ${outlineId} 0 R /Dest [4 0 R /Fit] /First ${outlineId + 2} 0 R /Last ${outlineId + 2} 0 R /Count 1 >>`,
        `<< /Title (Details) /Parent ${outlineId + 1} 0 R /Dest [4 0 R /Fit] >>`,
    )
    let pdf = '%PDF-1.7\n'
    const offsets = [0]
    objects.forEach((object, i) => {
        offsets.push(Buffer.byteLength(pdf))
        pdf += `${i + 1} 0 obj\n${object}\nendobj\n`
    })
    const xref = Buffer.byteLength(pdf)
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
    return Buffer.from(pdf)
}

const body = 'This is enough ordinary body text to establish the document font size.'
const text = (value: string, size: number, y: number) => `BT /F1 ${size} Tf 50 ${y} Td (${value}) Tj ET`

describe('PDF Markdown ingestion', () => {
    test('extracts heading levels, body lines and page boundaries without changing the source', async () => {
        const buffer = makePdf([
            [text('Overview', 24, 730), text(body, 12, 695), text('Details', 18, 655), text(body, 12, 625)].join('\n'),
            text('Second page body.', 12, 730),
        ])
        const original = Buffer.from(buffer)
        const markdown = await parseDocument(buffer, 'report.PDF')
        expect(markdown).toBe(`# Overview\n\n${body}\n\n## Details\n\n${body}\n\nSecond page body.`)
        expect(buffer).toEqual(original)
    })

    test('uses nested bookmarks even when headings have the body font size', async () => {
        const buffer = makePdf([[text('Overview', 12, 730), text(body, 12, 700), text('Details', 12, 665), text(body, 12, 640)].join('\n')], true)
        expect(await parseDocument(buffer, 'bookmarks.pdf')).toContain(`## Details\n\n${body}`)
    })

    test('does not invent headings for ordinary text', async () => {
        expect(await parseDocument(makePdf([text(body, 12, 700)]), 'plain.pdf')).toBe(body)
    })

    test('preserves line and paragraph gaps and separates positioned words', async () => {
        const stream = [
            text('Hello', 12, 700),
            'BT /F1 12 Tf 90 700 Td (world) Tj ET',
            text('Next line', 12, 685),
            text('New paragraph', 12, 640),
            text('1. First item', 12, 610),
            text('2. Second item', 12, 595),
        ].join('\n')
        expect(await parseDocument(makePdf([stream]), 'layout.pdf')).toBe('Hello world\nNext line\n\nNew paragraph\n\n1. First item\n\n2. Second item')
    })

    test('rejects PDFs with no text and malformed PDFs', async () => {
        await expect(parseDocument(makePdf(['']), 'scan.pdf')).rejects.toThrow('require OCR')
        await expect(parseDocument(Buffer.from('not a pdf'), 'bad.pdf')).rejects.toThrow()
    })

    test('persists Markdown and the unchanged PDF for a base64 attachment', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'cynosure-unpdf-'))
        vi.stubEnv('CYNOSURE_DATA_DIR', directory)
        try {
            const buffer = makePdf([text(body, 12, 700)])
            const artifact = await materializeFileAttachment({ name: 'report.pdf', content: `data:application/pdf;base64,${buffer.toString('base64')}` }, 'pdf-test')
            expect(await readFile(artifact.textPath, 'utf8')).toBe(body)
            expect(await readFile(artifact.originalPath)).toEqual(buffer)
        } finally {
            vi.unstubAllEnvs()
            await rm(directory, { recursive: true, force: true })
        }
    })

    test('keeps the DOCX conversion path working', async () => {
        const zip = new AdmZip()
        zip.addFile('word/document.xml', Buffer.from('<w:document><w:body><w:p><w:r><w:t>Office text</w:t></w:r></w:p></w:body></w:document>'))
        expect(await parseDocument(zip.toBuffer(), 'office.docx')).toBe('Office text')
    })
})
