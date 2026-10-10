import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getProjectPath } from './path';
import { basename, join, resolve } from 'node:path';

vi.mock('node:os', () => ({
    homedir: vi.fn(() => '/home/user')
}));

// Store original env
const originalEnv = process.env;

function expectedProjectPath(workingDir: string, claudeConfigDir = join('/home/user', '.claude')): string {
    return join(
        claudeConfigDir,
        'projects',
        resolve(workingDir).replace(/[^a-zA-Z0-9]/g, '-')
    );
}

describe('getProjectPath', () => {
    beforeEach(() => {
        // Reset process.env to a clean state
        process.env = { ...originalEnv };
        delete process.env.CLAUDE_CONFIG_DIR;
    });

    afterEach(() => {
        // Restore original env
        process.env = originalEnv;
    });
    it('should replace slashes with hyphens in the project path', () => {
        const workingDir = '/Users/steve/projects/my-app';
        const result = getProjectPath(workingDir);
        expect(result).toBe(expectedProjectPath(workingDir));
    });

    it('should replace dots with hyphens in the project path', () => {
        const workingDir = '/Users/steve/projects/app.test.js';
        const result = getProjectPath(workingDir);
        expect(result).toBe(expectedProjectPath(workingDir));
    });

    it('should handle paths with both slashes and dots', () => {
        const workingDir = '/var/www/my.site.com/public';
        const result = getProjectPath(workingDir);
        expect(result).toBe(expectedProjectPath(workingDir));
    });

    it('should replace underscores with hyphens in the project path', () => {
        const workingDir = '/data/github/hapi__worktrees/ime';
        const result = getProjectPath(workingDir);
        expect(result).toBe(expectedProjectPath(workingDir));
    });

    it('should handle relative paths by resolving them first', () => {
        const workingDir = './my-project';
        const result = getProjectPath(workingDir);
        expect(result).toContain(join('/home/user', '.claude', 'projects'));
        expect(result).toContain('my-project');
    });

    it('should handle empty directory path', () => {
        const workingDir = '';
        const result = getProjectPath(workingDir);
        expect(result).toContain(join('/home/user', '.claude', 'projects'));
    });

    // Fixed vectors independently checked against Claude Code 2.1.283's
    // UTF-16 / signed int32 path hash. Keep the expected suffixes literal.
    it.skipIf(process.platform === 'win32')('matches a directory actually created by Claude Code 2.1.283', () => {
        const root = '/home/tiger/workspace/runweft/.dev-smoke/hapi-session-and-shutdown/path-probe';
        const cwd = `${root}/${'a'.repeat(110)}/${'b'.repeat(110)}`;
        expect(basename(getProjectPath(cwd))).toBe(
            `-home-tiger-workspace-runweft--dev-smoke-hapi-session-and-shutdown-path-probe-${'a'.repeat(110)}-${'b'.repeat(11)}-77odt8`
        );
    });
    it.skipIf(process.platform === 'win32')('keeps exactly 200 encoded code units and truncates at 201', () => {
        const prefix = `${resolve('/')}${'a'.repeat(199)}`;
        expect(basename(getProjectPath(prefix))).toBe(`-${'a'.repeat(199)}`);
        expect(basename(getProjectPath(`${prefix}a`))).toBe(`-${'a'.repeat(199)}-b6ymvl`);
    });

    it.skipIf(process.platform === 'win32')('hashes the full unencoded path and separates identical truncated prefixes', () => {
        const prefix = `/${'a'.repeat(199)}`;
        expect(basename(getProjectPath(`${prefix}/one`))).toBe(`-${'a'.repeat(199)}-rr6fnt`);
        expect(basename(getProjectPath(`${prefix}/two`))).toBe(`-${'a'.repeat(199)}-rr6jlb`);
        expect(getProjectPath(`${prefix}/one/`)).toBe(getProjectPath(`${prefix}/one`));
    });

    it.skipIf(process.platform === 'win32')('uses UTF-16 code units for BMP text and astral characters across the boundary', () => {
        expect(basename(getProjectPath(`/${'界'.repeat(200)}`))).toBe(`${'-'.repeat(200)}-blobf5`);
        expect(basename(getProjectPath(`/${'a'.repeat(199)}😀`))).toBe(`-${'a'.repeat(199)}-86sic5`);
        expect(basename(getProjectPath('/😀'))).toBe('---');
    });

    it('resolves relative long paths before encoding and respects the configured history root', () => {
        process.env.CLAUDE_CONFIG_DIR = '/dedicated/claude';
        const cwd = `./${'a'.repeat(110)}/${'b'.repeat(110)}`;
        expect(getProjectPath(cwd)).toBe(getProjectPath(resolve(cwd)));
        expect(getProjectPath(cwd).startsWith(join('/dedicated/claude', 'projects'))).toBe(true);
        expect(basename(getProjectPath(cwd))).toMatch(/^.{200}-[a-z0-9]+$/);
    });

    describe('CLAUDE_CONFIG_DIR support', () => {
        it('should use default .claude directory when CLAUDE_CONFIG_DIR is not set', () => {
            const workingDir = '/Users/steve/projects/my-app';
            const result = getProjectPath(workingDir);
            expect(result).toBe(expectedProjectPath(workingDir));
        });

        it('should use CLAUDE_CONFIG_DIR when set', () => {
            process.env.CLAUDE_CONFIG_DIR = '/custom/claude/config';
            const workingDir = '/Users/steve/projects/my-app';
            const result = getProjectPath(workingDir);
            expect(result).toBe(expectedProjectPath(workingDir, '/custom/claude/config'));
        });

        it('should handle relative CLAUDE_CONFIG_DIR path', () => {
            process.env.CLAUDE_CONFIG_DIR = './config/claude';
            const workingDir = '/Users/steve/projects/my-app';
            const result = getProjectPath(workingDir);
            expect(result).toBe(expectedProjectPath(workingDir, './config/claude'));
        });

        it('should fallback to default when CLAUDE_CONFIG_DIR is empty string', () => {
            process.env.CLAUDE_CONFIG_DIR = '';
            const workingDir = '/Users/steve/projects/my-app';
            const result = getProjectPath(workingDir);
            expect(result).toBe(expectedProjectPath(workingDir));
        });

        it('should handle CLAUDE_CONFIG_DIR with trailing slash', () => {
            process.env.CLAUDE_CONFIG_DIR = '/custom/claude/config/';
            const workingDir = '/Users/steve/projects/my-app';
            const result = getProjectPath(workingDir);
            expect(result).toBe(expectedProjectPath(workingDir, '/custom/claude/config/'));
        });
    });
});
