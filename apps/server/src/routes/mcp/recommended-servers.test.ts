import { describe, expect, it } from 'vitest'
import { recommendedServers } from './recommended-servers.js'

type RecommendedServer = {
    name: string
    repository?: { url?: string; source?: string; subfolder?: string }
    icons?: { src?: string }[]
    packages?: {
        registryType?: string
        identifier?: string
        environmentVariables?: { name: string; isRequired?: boolean }[]
    }[]
}

const expectedRepositories: Record<string, string> = {
    '@cynosure-mcp/chart-artifacts': 'mcp-charts',
    '@cynosure-mcp/claude-code-terminal': 'mcp-claude-code-terminal',
    '@cynosure-mcp/clockify': 'mcp-clockify',
    '@cynosure-mcp/codex-terminal': 'mcp-codex-terminal',
    '@cynosure-mcp/computer-controller': 'mcp-computer-controller',
    '@cynosure-mcp/defuddle': 'mcp-defuddle',
    '@cynosure-mcp/document-parser': 'mcp-document-parser',
    '@cynosure-mcp/imap-email': 'mcp-imap-email',
    '@cynosure-mcp/media-file-converter': 'mcp-media-file-converter',
    '@cynosure-mcp/mermaid-diagrams': 'mcp-mermaid-diagrams',
    '@cynosure-mcp/music-tagger': 'mcp-music-tagger',
    '@cynosure-mcp/nullpointer-file-share': 'mcp-nullpointer-file-share',
    '@cynosure-mcp/qr-code': 'mcp-qr-code',
    '@cynosure-mcp/sftp-ssh': 'mcp-sftp-ssh',
    '@cynosure-mcp/stability-ai': 'mcp-stability-ai',
    '@cynosure-mcp/system-notifications': 'mcp-system-notifications',
    '@cynosure-mcp/weather': 'mcp-weather',
    '@cynosure-mcp/webcam': 'mcp-webcam',
    '@cynosure-mcp/webfetch': 'mcp-webfetch',
    '@cynosure-mcp/youtube-video-downloader': 'mcp-youtube-video-downloader',
}

function cynosureEntries(): RecommendedServer[] {
    return recommendedServers
        .map((entry) => entry.server as RecommendedServer)
        .filter((server) => server.name.startsWith('@cynosure-mcp/'))
}

describe('recommended Cynosure MCP servers', () => {
    it('maps every package to its standalone repository and public npm icon', () => {
        const servers = cynosureEntries()

        expect(servers).toHaveLength(Object.keys(expectedRepositories).length)

        for (const server of servers) {
            const repositoryName = expectedRepositories[server.name]
            expect(repositoryName, `${server.name} must have a repository mapping`).toBeDefined()
            expect(server.repository).toEqual({
                url: `https://github.com/Cynosure-MCP-Collection/${repositoryName}`,
                source: 'github',
            })
            expect(server.icons?.[0]?.src).toBe(`https://unpkg.com/${server.name}@latest/icon.png`)
            expect(server.packages?.[0]?.identifier).toBe(`${server.name}@latest`)
        }
    })

    it('includes the required SFTP connection fields', () => {
        const server = cynosureEntries().find((entry) => entry.name === '@cynosure-mcp/sftp-ssh')
        const environmentVariables = server?.packages?.[0]?.environmentVariables ?? []

        expect(environmentVariables).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'SFTP_HOST', isRequired: true }),
            expect.objectContaining({ name: 'SFTP_USERNAME', isRequired: true }),
        ]))
    })

    it('contains no references to the retired monorepo', () => {
        expect(JSON.stringify(cynosureEntries())).not.toContain('andreasjhagen/Cynosure-MCPs')
        expect(JSON.stringify(cynosureEntries())).not.toContain('raw.githubusercontent.com')
        expect(JSON.stringify(cynosureEntries())).not.toContain('subfolder')
    })
})
