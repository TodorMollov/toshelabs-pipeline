import { spawn } from 'child_process';
import { readFile } from 'fs/promises';

/**
 * Spawn a claude CLI process and stream output
 */
export function spawnClaude({
  prompt,
  model = 'opus',
  tools = [],
  maxTurns = 30,
  systemPromptFile = null,
  workingDir = null,
  sessionId = null,
  bare = true,
  onData = null,
  env = {},
}) {
  return new Promise((resolve, reject) => {
    const args = ['-p'];

    // Model
    args.push('--model', model);

    // Output format — stream JSON for live UI
    args.push('--output-format', 'stream-json');

    // Verbose for full event stream
    args.push('--verbose');

    // Max turns
    if (maxTurns) args.push('--max-turns', String(maxTurns));

    // Tool restrictions
    if (tools.length > 0) {
      args.push('--allowedTools', tools.join(','));
    }

    // System prompt injection (validation rules)
    if (systemPromptFile) {
      args.push('--append-system-prompt-file', systemPromptFile);
    }

    // Session resume
    if (sessionId) {
      args.push('--resume', sessionId);
    }

    // Bare mode (skip hooks/skills/MCP)
    if (bare) {
      args.push('--bare');
    }

    // The prompt itself
    args.push(prompt);

    const proc = spawn('claude', args, {
      cwd: workingDir || process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let sessionIdParsed = null;
    let result = '';

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;

      // Parse stream-json lines
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (onData) onData(event);

          // Capture session ID
          if (event.session_id) {
            sessionIdParsed = event.session_id;
          }

          // Capture final result
          if (event.result) {
            result = event.result;
          }

          // Capture from content blocks
          if (event.type === 'content_block_delta' && event.delta?.text) {
            result += event.delta.text;
          }
        } catch {
          // Not JSON — raw output
          if (onData) onData({ type: 'raw', text: line });
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0 && code !== null) {
        reject(
          new Error(`claude exited with code ${code}: ${stderr || stdout}`)
        );
        return;
      }

      resolve({
        sessionId: sessionIdParsed,
        result,
        stdout,
        stderr,
        exitCode: code,
      });
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

/**
 * Check context usage via a quick haiku call
 */
export async function checkUsage(sessionId, model = 'haiku') {
  try {
    const result = await spawnClaude({
      prompt: '/usage',
      model,
      sessionId,
      maxTurns: 1,
      bare: true,
    });
    // Parse usage info from result
    const pctMatch = result.result?.match(/(\d+)%/);
    const tokMatch = result.result?.match(/([\d,]+)\s*\/\s*([\d,]+)/);
    return {
      percent: pctMatch ? parseInt(pctMatch[1]) : null,
      used: tokMatch ? parseInt(tokMatch[1].replace(/,/g, '')) : null,
      total: tokMatch ? parseInt(tokMatch[2].replace(/,/g, '')) : null,
      raw: result.result,
    };
  } catch {
    return { percent: null, raw: 'usage check failed' };
  }
}
