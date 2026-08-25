import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'
import ModalDialog from './ModalDialog.vue'

describe('ModalDialog stacking', () => {
  test('raises nested dialogs above their parent modal', () => {
    const wrapper = mount(ModalDialog, {
      attachTo: document.body,
      props: {
        show: true,
        title: 'Confirm reset',
        layer: 'nested',
      },
    })

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog?.parentElement?.classList.contains('z-[1000]')).toBe(true)
    expect(dialog?.parentElement?.style.zIndex).toBe('1000')
    wrapper.unmount()
  })
})
