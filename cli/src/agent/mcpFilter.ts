/** Full disabled definitions also work when the execution account never installed the server. */
export function disabledCodexMcpConfig(servers: readonly string[] = []): Record<string, unknown> {
    return Object.fromEntries(servers.map(name => [
        `mcp_servers.${name}`, { command: 'hapi-disabled-mcp-placeholder', enabled: false }
    ]));
}

export function disabledClaudeMcpTools(servers: readonly string[] = []): string[] {
    return servers.map(name => `mcp__${name}__*`);
}
