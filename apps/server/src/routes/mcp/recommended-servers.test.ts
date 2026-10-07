import { describe, expect, it } from 'vitest'
import { CYNOSURE_META_KEY, recommendedServers } from './recommended-servers.js'

type RecommendedServer = {
    name: string
    title?: string
    repository?: { url?: string; source?: string }
    icons?: { src?: string }[]
    remotes?: { type: string; url: string; headers?: { name: string; value?: string }[] }[]
    packages?: { registryType?: string; identifier?: string; transport?: { type?: string } }[]
}

const servers = recommendedServers.map((entry) => entry.server as RecommendedServer)

const expectedCynosureRepositories: Record<string, string> = {
    '@cynosure-mcp/claude-code-terminal': 'mcp-claude-code-terminal',
    '@cynosure-mcp/codex-terminal': 'mcp-codex-terminal',
    '@cynosure-mcp/computer-controller': 'mcp-computer-controller',
    '@cynosure-mcp/document-parser': 'mcp-document-parser',
    '@cynosure-mcp/imap-email': 'mcp-imap-email',
    '@cynosure-mcp/media-file-converter': 'mcp-media-file-converter',
    '@cynosure-mcp/sftp-ssh': 'mcp-sftp-ssh',
    '@cynosure-mcp/system-notifications': 'mcp-system-notifications',
    '@cynosure-mcp/weather': 'mcp-weather',
    '@cynosure-mcp/webcam': 'mcp-webcam',
    '@cynosure-mcp/webfetch': 'mcp-webfetch',
    '@cynosure-mcp/youtube-video-downloader': 'mcp-youtube-video-downloader',
}

function cynosureNames(): string[] {
    return servers.map((server) => server.name).filter((name) => name.startsWith('@cynosure')).sort()
}

describe('recommended MCP servers', () => {
    it('keeps only the selected Cynosure servers and drops retired picks', () => {
        const names = servers.map((server) => server.name)

        expect(cynosureNames()).toEqual(Object.keys(expectedCynosureRepositories).sort())
        for (const removed of ['clockify', 'chart-artifacts', 'mermaid-diagrams', 'music-tagger', 'qr-code', 'stability-ai']) {
            expect(names).not.toContain(`@cynosure-mcp/${removed}`)
        }
        expect(names).not.toContain('@modelcontextprotocol/server-filesystem')
        expect(names).not.toContain('@katomato65/time-mcp')
        expect(names).not.toContain('@toolsdk.ai/tavily-mcp')
    })

    it('maps every Cynosure package to its standalone repository and public npm icon', () => {
        for (const server of servers.filter((entry) => entry.name.startsWith('@cynosure-mcp/'))) {
            expect(server.repository).toEqual({
                url: `https://github.com/Cynosure-MCP-Collection/${expectedCynosureRepositories[server.name]}`,
                source: 'github',
            })
            expect(server.icons?.[0]?.src).toBe(`https://unpkg.com/${server.name}@latest/icon.png`)
        }
    })

    it('has unique names, a title, an icon, a category and a publisher for every entry', () => {
        expect(new Set(servers.map((server) => server.name)).size).toBe(servers.length)

        for (const entry of recommendedServers) {
            const server = entry.server as RecommendedServer
            expect(server.title, server.name).toBeTruthy()
            expect(server.icons?.[0]?.src, server.name).toMatch(/^https:\/\//)
            expect(entry._meta?.[CYNOSURE_META_KEY]).toEqual({
                category: expect.stringMatching(/^(productivity|development|files|web|media|ai|communication|utilities)$/),
                publisher: expect.any(String),
            })
        }
    })

    it('only uses installers that need no extra runtime: hosted remotes or npm packages', () => {
        for (const server of servers) {
            const remote = server.remotes?.[0]
            const pkg = server.packages?.[0]
            if (remote) {
                expect(remote.type).toBe('streamable-http')
                expect(remote.url).toMatch(/^https:\/\//)
            } else {
                expect(pkg?.registryType, server.name).toBe('npm')
                expect(pkg?.transport?.type).toBe('stdio')
                expect(pkg?.identifier).toBe(`${server.name}@latest`)
            }
        }
    })

    it('asks only for a token when connecting GitHub', () => {
        const github = servers.find((server) => server.name === 'github')
        expect(github?.remotes?.[0]?.headers).toEqual([
            expect.objectContaining({ name: 'Authorization', value: 'Bearer {GITHUB_PERSONAL_ACCESS_TOKEN}' }),
        ])
    })
})
