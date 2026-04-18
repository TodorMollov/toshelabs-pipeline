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
  effort = null,
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

    // Effort level (thinking depth)
    if (effort) args.push('--effort', effort);

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

    // Skip non-essential features but keep auth
    if (bare) {
      args.push('--disable-slash-commands');
      args.push('--permission-mode', 'bypassPermissions');
    }

    // Prompt is piped via stdin to avoid OS ARG_MAX limits on large prompts
    const claudeBin = process.env.CLAUDE_BIN || 'claude';
    // Expand ${VAR} references in env values using process.env
    const expandedEnv = {};
    for (const [k, v] of Object.entries(env)) {
      expandedEnv[k] = String(v).replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '');
    }
    const proc = spawn(claudeBin, args, {
      cwd: workingDir || process.cwd(),
      env: { ...process.env, ...expandedEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Pipe prompt to stdin
    proc.stdin.write(prompt);
    proc.stdin.end();

    let stdout = '';
    let stderr = '';
    let sessionIdParsed = null;
    let result = '';
    let rateLimitInfo = null;

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;

      // Parse stream-json lines
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (onData) onData(event);

          // Log assistant text and tool use to stdout
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text' && block.text) {
                process.stdout.write(block.text);
              } else if (block.type === 'tool_use') {
                const summary = block.name === 'Read' ? block.input?.file_path
                  : block.name === 'Edit' ? block.input?.file_path
                  : block.name === 'Bash' ? block.input?.command?.slice(0, 150)
                  : block.name === 'Grep' ? `"${block.input?.pattern}" ${block.input?.path || ''}`
                  : block.name === 'Glob' ? block.input?.pattern
                  : block.name === 'Write' ? block.input?.file_path
                  : block.name === 'Agent' ? block.input?.description
                  : JSON.stringify(block.input).slice(0, 150);
                console.log(`\n[tool] ${block.name}: ${summary}`);
              }
            }
          }

          // Capture rate limit info from stream events
          if (event.type === 'rate_limit_event' && event.rate_limit_info) {
            rateLimitInfo = event.rate_limit_info;
          }

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
      // Detect rate limit / usage limit
      const allOutput = stdout + stderr + result;
      const limitMatch = allOutput.match(/(?:hit your limit|rate.?limit|usage.?limit).*?resets?\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:\(([^)]+)\))?/i);
      if (limitMatch || allOutput.includes('hit your limit')) {
        const err = new Error(`claude rate limited: ${result || stderr}`);
        err.rateLimited = true;
        err.resetTime = limitMatch?.[1] || null;
        err.resetTimezone = limitMatch?.[2] || null;
        reject(err);
        return;
      }

      if (code !== 0 && code !== null) {
        // "Reached maximum number of turns" exits with code 1 but the step
        // may have completed its work — let the pipeline gate decide
        if (allOutput.includes('maximum number of turns')) {
          console.log(`[runner] max turns reached — treating as success, gate will validate`);
          resolve({
            sessionId: sessionIdParsed,
            result,
            stdout,
            stderr,
            exitCode: code,
            maxTurnsHit: true,
            rateLimitInfo,
          });
          return;
        }

        // Extract a meaningful error from the output instead of dumping raw JSON
        let errorMsg = stderr.trim();
        if (!errorMsg) {
          // Try to find an error message in the JSON stream
          const errorMatch = allOutput.match(/"error"\s*:\s*"([^"]+)"/);
          const resultMatch = allOutput.match(/"result"\s*:\s*"([^"]{1,200})/);
          const isErrorMatch = allOutput.match(/"is_error"\s*:\s*true/);
          errorMsg = errorMatch?.[1] || resultMatch?.[1] || result?.slice(0, 200) || stdout?.slice(-500) || 'unknown error';
          if (isErrorMatch && resultMatch) {
            errorMsg = `[is_error] ${resultMatch[1]}`;
          }
        }
        // Log full details to stdout for debugging
        console.error(`[runner] claude exit ${code} | stderr: ${stderr.slice(0, 200)} | error: ${errorMsg} | result: ${(result || '').slice(0, 200)}`);
        reject(
          new Error(`claude exited with code ${code}: ${errorMsg}`)
        );
        return;
      }

      resolve({
        sessionId: sessionIdParsed,
        result,
        stdout,
        stderr,
        exitCode: code,
        rateLimitInfo,
      });
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

