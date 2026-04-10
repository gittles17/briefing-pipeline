import { readdir, readFile, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

const CLAUDE_DIR = join(homedir(), '.claude', 'projects');

export async function fetchClaudeSessions(hoursBack = 24): Promise<string> {
  try {
    const cutoff = Date.now() - hoursBack * 3600 * 1000;
    const sessions: { project: string; messages: string[]; timestamp: number }[] = [];

    // Scan all project directories
    const projects = await readdir(CLAUDE_DIR).catch(() => []);
    for (const project of projects) {
      const projectDir = join(CLAUDE_DIR, project);
      const projectStat = await stat(projectDir).catch(() => null);
      if (!projectStat?.isDirectory()) continue;

      // Find JSONL session files modified recently
      const files = await readdir(projectDir).catch(() => []);
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const filePath = join(projectDir, file);
        const fileStat = await stat(filePath).catch(() => null);
        if (!fileStat || fileStat.mtimeMs < cutoff) continue;

        // Parse user messages from this session
        const content = await readFile(filePath, 'utf-8').catch(() => '');
        const userMessages: string[] = [];
        let sessionTimestamp = 0;

        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);

            // Track latest timestamp
            if (entry.timestamp) {
              const ts = new Date(entry.timestamp).getTime();
              if (ts > sessionTimestamp) sessionTimestamp = ts;
            }

            // Extract user messages
            if (entry.type === 'user' && entry.message?.content) {
              const text = typeof entry.message.content === 'string'
                ? entry.message.content
                : Array.isArray(entry.message.content)
                  ? entry.message.content
                      .filter((b: any) => b.type === 'text')
                      .map((b: any) => b.text)
                      .join(' ')
                  : '';

              // Skip very short messages (acknowledgements) and system content
              const cleaned = text.trim();
              if (cleaned.length > 10 && !cleaned.startsWith('claude --')) {
                userMessages.push(cleaned);
              }
            }
          } catch {
            // Skip malformed lines
          }
        }

        if (userMessages.length > 0 && sessionTimestamp > cutoff) {
          // Clean project name: "-Users-jonathan-gitlin-Desktop-Brief" → "Brief"
          const projectName = project
            .replace(/-Users-jonathan[.-]gitlin-Desktop-/i, '')
            .replace(/-/g, ' ');

          sessions.push({
            project: projectName,
            messages: userMessages,
            timestamp: sessionTimestamp,
          });
        }
      }
    }

    if (sessions.length === 0) return '(no recent Claude sessions)';

    // Sort by most recent first
    sessions.sort((a, b) => b.timestamp - a.timestamp);

    // Format output: project name + summary of what was discussed
    const output: string[] = [];
    for (const session of sessions) {
      const timeAgo = Math.round((Date.now() - session.timestamp) / 3600000);
      output.push(`PROJECT: ${session.project} (${timeAgo}h ago)`);
      // Include up to 8 user messages to capture the scope of work
      const msgs = session.messages.slice(0, 8);
      for (const msg of msgs) {
        // Truncate long messages
        const truncated = msg.length > 200 ? msg.substring(0, 200) + '...' : msg;
        output.push(`  - ${truncated}`);
      }
      output.push('');
    }

    return output.join('\n');
  } catch {
    return '(claude sessions unavailable)';
  }
}
