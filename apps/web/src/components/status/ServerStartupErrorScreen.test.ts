import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'
import ServerStartupErrorScreen from './ServerStartupErrorScreen.vue'

describe('ServerStartupErrorScreen', () => {
  test('explains a database written by a newer build', () => {
    const wrapper = mount(ServerStartupErrorScreen, {
      props: {
        serverVersion: '1.0.0',
        error: {
          code: 'database_version_mismatch',
          message: 'Database schema version 23 was written by a newer version of Cynosure (this build supports 22).',
          databasePath: '/data/sqlite/cynosure.db',
          databaseVersion: 23,
          supportedVersion: 22,
        },
      },
    })

    expect(wrapper.get('[role="alertdialog"]').text()).toContain('Your data needs a newer version of Cynosure')
    const details = wrapper.get('dl').text()
    expect(details).toContain('v23')
    expect(details).toContain('up to v22')
    expect(details).toContain('/data/sqlite/cynosure.db')
    expect(wrapper.text()).toContain('Update the Cynosure server, then restart it.')
  })

  test('reports other database failures with the raw error', () => {
    const wrapper = mount(ServerStartupErrorScreen, {
      props: {
        serverVersion: '1.0.0',
        error: { code: 'database_open_failed', message: 'SQLITE_CORRUPT: database disk image is malformed' },
      },
    })

    expect(wrapper.text()).toContain('Cynosure could not open its database')
    expect(wrapper.get('pre').text()).toBe('SQLITE_CORRUPT: database disk image is malformed')
    expect(wrapper.get('dl').text()).not.toContain('schema')
  })
})
