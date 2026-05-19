type RegistryServerEntry = {
    server: Record<string, unknown>
    _meta?: Record<string, unknown>
}

export const recommendedServers: RegistryServerEntry[] = [
    {
        server: {
            name: '@katomato65/time-mcp',
            title: 'Time MCP',
            description: 'Time and timezone utilities for current time, conversions, and date-aware workflows.',
            version: 'latest',
            packages: [{
                registryType: 'npm',
                identifier: '@katomato65/time-mcp',
                version: 'latest',
                transport: { type: 'stdio' },
            }],
        },
    },
    {
        server: {
            name: '@toolsdk.ai/tavily-mcp',
            title: 'Tavily MCP',
            description: 'Web search and extraction powered by Tavily.',
            version: 'latest',
            packages: [{
                registryType: 'npm',
                identifier: '@toolsdk.ai/tavily-mcp',
                version: 'latest',
                transport: { type: 'stdio' },
                environmentVariables: [{
                    name: 'TAVILY_API_KEY',
                    description: 'Tavily API key',
                    isRequired: true,
                    format: 'password',
                }],
            }],
        },
    },
    {
        server: {
            name: '@cynosure-mcp/weather',
            title: 'Weather',
            description: 'Weather lookup tools for forecasts and current conditions.',
            version: 'latest',
            packages: [{
                registryType: 'npm',
                identifier: '@cynosure-mcp/weather',
                version: 'latest',
                transport: { type: 'stdio' },
            }],
        },
    },
    {
        server: {
            name: 'chrome-devtools-mcp',
            title: 'Chrome DevTools',
            description: 'Control and inspect Chrome tabs for browser automation, screenshots, console output, and page debugging.',
            version: 'latest',
            packages: [{
                registryType: 'npm',
                identifier: 'chrome-devtools-mcp@latest',
                version: 'latest',
                transport: { type: 'stdio' },
            }],
        },
    },
    {
        server: {
            name: '@cynosure-mcp/computer-controller',
            title: 'Computer Controller',
            description: 'Control the desktop: open apps, capture screenshots, move the mouse, type text, and interact with the OS.',
            version: 'latest',
            packages: [{
                registryType: 'npm',
                identifier: '@cynosure-mcp/computer-controller@latest',
                version: 'latest',
                transport: { type: 'stdio' },
            }],
        },
    },
    {
        server: {
            name: '@modelcontextprotocol/server-filesystem',
            title: 'Filesystem',
            description: 'Read and write files within a directory you explicitly allow.',
            version: 'latest',
            packages: [{
                registryType: 'npm',
                identifier: '@modelcontextprotocol/server-filesystem',
                version: 'latest',
                transport: { type: 'stdio' },
                environmentVariables: [{
                    name: 'DIRECTORY',
                    description: 'Directory path to grant this MCP access to',
                    isRequired: true,
                }],
                arguments: [{ fromEnv: 'DIRECTORY' }],
            }],
        },
    },
    {
        server: {
            name: '@cynosure-mcp/youtube-video-downloader',
            title: 'YouTube Video Downloader',
            description: 'Download video and audio from YouTube and other supported media sites.',
            version: 'latest',
            packages: [{
                registryType: 'npm',
                identifier: '@cynosure-mcp/youtube-video-downloader',
                version: 'latest',
                transport: { type: 'stdio' },
            }],
        },
    },
    {
        server: {
            name: '@cynosure-mcp/cynosure',
            title: 'Cynosure',
            description: 'Manage Cynosure agents, memory, MCP servers, and settings through MCP tools.',
            version: 'latest',
            packages: [{
                registryType: 'npm',
                identifier: '@cynosure-mcp/cynosure',
                version: 'latest',
                transport: { type: 'stdio' },
            }],
        },
    },
    {
        server: {
            name: '@cynosure-mcp/media-file-converter',
            title: 'Media File Converter',
            description: 'Convert audio, video, and image files between common media formats.',
            version: 'latest',
            packages: [{
                registryType: 'npm',
                identifier: '@cynosure-mcp/media-file-converter',
                version: 'latest',
                transport: { type: 'stdio' },
            }],
        },
    },
]
