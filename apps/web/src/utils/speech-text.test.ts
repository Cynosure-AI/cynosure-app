import { describe, expect, test } from 'vitest'
import { lastSpeakableCut, SpeechStreamChunker, splitSentences, toSpeakableText } from './speech-text'

describe('toSpeakableText', () => {
    test('keeps prose and drops code, tables, URLs and emoji', () => {
        const markdown = [
            '## Setup 🚀',
            '',
            'Run the **install** step from [the docs](https://example.com/docs), see https://example.com.',
            '',
            '```bash',
            'pnpm install',
            '```',
            '',
            '| Name | Size |',
            '| --- | ---: |',
            '| aru | 77 MB |',
            '',
            '- First item',
            '- Uses `snake_case` names',
            '> Quoted text',
        ].join('\n')

        expect(toSpeakableText(markdown)).toBe(
            'Setup. Run the install step from the docs, see. First item. Uses snake case names. Quoted text.',
        )
    })

    test('drops an unclosed code block to the end', () => {
        expect(toSpeakableText('Here it is:\n```ts\nconst a = 1')).toBe('Here it is:')
    })
})

describe('splitSentences', () => {
    test('splits on sentence ends but not abbreviations or decimals', () => {
        expect(splitSentences('Version 3.5 is out. Use it, e.g. for tests! Dr. Smith agrees? Ja, z.B. heute.'))
            .toEqual(['Version 3.5 is out.', 'Use it, e.g. for tests!', 'Dr. Smith agrees?', 'Ja, z.B. heute.'])
    })

    test('breaks very long sentences at a comma', () => {
        const long = `${'word '.repeat(70).trim()}, ${'more '.repeat(30).trim()}.`
        const parts = splitSentences(long)
        expect(parts.length).toBeGreaterThan(1)
        expect(parts.every((part) => part.length <= 280)).toBe(true)
        expect(parts.join(' ')).toBe(long)
    })
})

describe('lastSpeakableCut', () => {
    test('waits for whitespace after a period', () => {
        expect(lastSpeakableCut('It costs 3.')).toBe(0)
        expect(lastSpeakableCut('It costs 3.5 euros. Then')).toBe('It costs 3.5 euros.'.length)
    })

    test('never cuts inside a code block or table row', () => {
        expect(lastSpeakableCut('Intro.\n```\nfoo. bar\n')).toBe('Intro.\n'.length)
        expect(lastSpeakableCut('| a. b')).toBe(0)
    })
})

describe('SpeechStreamChunker', () => {
    test('emits sentences as they complete and the rest on flush', () => {
        const chunker = new SpeechStreamChunker()
        expect(chunker.push('Hello th')).toEqual([])
        expect(chunker.push('ere. How are')).toEqual(['Hello there.'])
        expect(chunker.push(' you?\n```js\nx = 1. y\n')).toEqual(['How are you?'])
        expect(chunker.push('```\nDone')).toEqual([])
        expect(chunker.flush()).toEqual(['Done.'])
    })

    test('reset drops text that was not spoken yet', () => {
        const chunker = new SpeechStreamChunker()
        chunker.push('Partial thought')
        chunker.reset()
        expect(chunker.flush()).toEqual([])
    })
})
