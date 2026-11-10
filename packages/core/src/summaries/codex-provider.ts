import { CLI_ENGINES } from '../settings/cli-providers';
import type { CliProviderOptions } from './claude-code-provider';
import type { CliProcessRunner } from './cli-failure';
import { codexExecArgs } from './cli-invocation';
import { CliToolProvider } from './cli-provider';

export class CodexSummaryProvider extends CliToolProvider {
  readonly id = CLI_ENGINES.Codex.providerId;
  protected readonly executable = CLI_ENGINES.Codex.executable;
  protected readonly displayName = CLI_ENGINES.Codex.displayName;

  constructor(
    runner: CliProcessRunner,
    private readonly options: CliProviderOptions = {},
  ) {
    super(runner, options.timeoutMs);
  }

  protected buildArgs(): readonly string[] {
    return codexExecArgs(this.options);
  }
}

/** The plain provider for summaries, titles and prompts. */
export function createCodexProvider(
  runner: CliProcessRunner,
  options: Omit<CliProviderOptions, 'webSearch'> = {},
): CodexSummaryProvider {
  return new CodexSummaryProvider(runner, { ...options, webSearch: false });
}

/** The web-search variant, for the live-answer path only. */
export function createCodexWebSearchProvider(
  runner: CliProcessRunner,
  options: Omit<CliProviderOptions, 'webSearch'> = {},
): CodexSummaryProvider {
  return new CodexSummaryProvider(runner, { ...options, webSearch: true });
}
