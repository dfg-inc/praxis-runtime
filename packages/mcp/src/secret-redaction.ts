import { redactCredentials, redactCredentialsDeep } from "@praxis/contracts";

/**
 * The Runtime's output boundary for credentials. One function, redactCredentials (contracts secret-redaction.ts), replaces
 * the exact value of every credential this server process holds (PRAXIS_JIRA_TOKEN, PRAXIS_GITHUB_TOKEN, PRAXIS_GITLAB_TOKEN,
 * PRAXIS_GIT_TOKEN, GITHUB_TOKEN, GH_TOKEN, GITLAB_TOKEN, and credentials registered from configuration) with
 * `[REDACTED:<NAME>]`, and it is applied where output leaves the process:
 *   - callTool's return: every tool result and every error envelope (redactEnvelope);
 *   - the protocol handler: an error thrown out of a tool call (server.ts);
 *   - process.stdout and process.stderr: every protocol message (dialogs included) and every log line (installOutputRedaction);
 *   - the diagnostics log file (diagnostics-log.ts).
 *
 * It keeps a credential value from reaching the model context through Praxis's own output by accident (repository content
 * or a remote error echoing a token). It is hygiene, not a boundary: it does not stop anything that reads the token itself.
 * The variables stay in the environment this process inherited; any process started the same way, an agent's shell
 * included, has them, and any program running as the user, repository code Praxis starts included, can read this process's
 * initial environment (`ps -E`, `/proc/<pid>/environ`), the Desktop extension's token included, and print it in a form
 * redaction does not know. Praxis cannot remove a variable from an already inherited environment (praxis_doctor
 * credentialExposure names them).
 */

export { redactCredentials };

/** A tool result or error envelope with every credential value replaced. */
export const redactEnvelope = <T>(envelope: T): T => redactCredentialsDeep(envelope);

/** An error thrown out of a tool call, with its message redacted (stack traces are not passed on). */
export function redactError(error: unknown): Error {
  const message = redactCredentials(error instanceof Error ? error.message : String(error));
  const out = new Error(message);
  if (error instanceof Error) out.name = error.name;
  return out;
}

let installed = false;

/**
 * Every chunk written to stdout (the MCP protocol stream) and stderr (the server's log, which the client stores) passes
 * redactCredentials. A JSON protocol line stays valid: a value is replaced inside its JSON string by text that needs no
 * escaping, and the JSON-escaped form of each value is matched as well.
 */
export function installOutputRedaction(streams: Array<NodeJS.WriteStream> = [process.stdout, process.stderr]): void {
  if (installed) return;
  installed = true;
  for (const stream of streams) {
    const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
    (stream as unknown as { write: typeof write }).write = (chunk: unknown, ...rest: unknown[]): boolean => {
      if (typeof chunk === "string") return write(redactCredentials(chunk), ...rest);
      if (chunk instanceof Uint8Array) {
        const text = Buffer.from(chunk).toString("utf8");
        const redacted = redactCredentials(text);
        return write(redacted === text ? chunk : Buffer.from(redacted, "utf8"), ...rest);
      }
      return write(chunk, ...rest);
    };
  }
}
