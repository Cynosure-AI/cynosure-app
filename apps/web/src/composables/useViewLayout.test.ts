import { beforeEach, describe, expect, test } from 'vitest'
import { resetViewLayout, useViewLayout } from './useViewLayout'

describe('useViewLayout', () => {
    beforeEach(() => {
        sessionStorage.clear()
        resetViewLayout()
    })

    test('uses each view\'s fallback until a layout is picked', () => {
        expect(useViewLayout('grid').value).toBe('grid')
        expect(useViewLayout(() => 'list').value).toBe('list')
    })

    test('shares the picked layout across views and keeps it for the session', () => {
        const library = useViewLayout('grid')
        const memory = useViewLayout('list')

        library.value = 'list'
        expect(memory.value).toBe('list')
        expect(sessionStorage.getItem('cy-view-layout')).toBe('list')

        memory.value = 'grid'
        expect(library.value).toBe('grid')
    })
})
