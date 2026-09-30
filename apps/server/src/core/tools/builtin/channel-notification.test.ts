import { describe, expect, it, vi } from 'vitest'
import { resolveNotificationTarget } from './channel-notification.js'
import { resolveChannelTarget } from '../../triggers/channel-target-resolver.js'

vi.mock('../../triggers/channel-target-resolver.js', () => ({ resolveChannelTarget: vi.fn(() => null) }))

describe('channel notification target resolution', () => {
    it('prefers a recently active recipient over the Telegram allow-list', () => {
        vi.mocked(resolveChannelTarget).mockReturnValueOnce('recent-user')
        expect(resolveNotificationTarget({ id: 'channel', type: 'telegram', config: { allowedUserIds: ['12345'] } }))
            .toBe('recent-user')
    })
    it('uses the configured Telegram user when there is no prior channel conversation', () => {
        expect(resolveNotificationTarget({
            id: 'new-channel',
            type: 'telegram',
            config: { allowedUserIds: [' 12345 ', 'invalid'] },
        })).toBe('12345')
    })
})
