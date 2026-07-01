import { injectable, inject } from "@theia/core/shared/inversify";
import { LanguageSelector } from "@theia/editor/lib/common/language-selector";
import { CancellationToken } from "@theia/core/shared/vscode-languageserver-protocol";
import { CallHierarchyService, CallHierarchySession } from "@theia/callhierarchy/lib/browser/callhierarchy-service";
import { CallHierarchyIncomingCall } from "@theia/callhierarchy/lib/browser/callhierarchy";
import { RepoGraphClient } from "./repo-graph-client";
import { AISymbol } from "./types";
import { aisymbolToCallItem, uriToRepoPath } from "./type-utils";

const SUPPORTED_LANGUAGES = ["typescript", "javascript", "python", "go", "rust"];

const selector: LanguageSelector = SUPPORTED_LANGUAGES.map(lang => ({
  language: lang,
  scheme: "file",
}));

@injectable()
export class MiziCallHierarchyService implements CallHierarchyService {
  readonly selector = selector;

  @inject(RepoGraphClient)
  private readonly client: RepoGraphClient;

  async getRootDefinition(
    uri: string,
    position: { line: number; character: number },
    _cancellationToken: CancellationToken
  ): Promise<CallHierarchySession | undefined> {
    const sym = await this.client.getSymbolAtPosition(uri, position.line);
    if (!sym) return undefined;
    const sessionId = `mizi:${Date.now()}`;
    const item = aisymbolToCallItem(sym, sessionId);
    return {
      items: [item],
      dispose: () => {},
    };
  }

  async getCallers(
    definition: { _sessionId?: string; _itemId?: string; name: string; uri: { path: string }; selectionRange: { start: { line: number } } },
    _cancellationToken: CancellationToken
  ): Promise<CallHierarchyIncomingCall[] | undefined> {
    const sym: AISymbol = {
      name: definition.name,
      kind: "",
      filePath: uriToRepoPath(definition.uri.path),
      line: definition.selectionRange.start.line,
    };
    const candidates = await this.client.getCallerCandidates(sym);
    return candidates.map(c => ({
      from: aisymbolToCallItem(c, definition._sessionId ?? `mizi:${Date.now()}`),
      fromRanges: [],
    }));
  }
}
