import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function getProjectPath(workingDirectory: string) {
    const absolutePath = resolve(workingDirectory);
    let projectId = absolutePath.replace(/[^a-zA-Z0-9]/g, '-');
    // Claude Code limits the encoded prefix to 200 UTF-16 code units and
    // hashes the complete original path, including characters replaced above.
    if (projectId.length > 200) {
        let hash = 0;
        for (let i = 0; i < absolutePath.length; i++) {
            hash = ((hash << 5) - hash + absolutePath.charCodeAt(i)) | 0;
        }
        projectId = `${projectId.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
    }
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    return join(claudeConfigDir, 'projects', projectId);
}
