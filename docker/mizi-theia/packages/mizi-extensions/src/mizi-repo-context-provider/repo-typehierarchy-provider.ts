import { injectable, inject, postConstruct } from "@theia/core/shared/inversify";
import { CancellationToken } from "@theia/core/shared/vscode-languageserver-protocol";
import { TypeHierarchyRegistry, TypeHierarchyProvider, TypeHierarchyParams, ResolveTypeHierarchyItemParams, TypeHierarchyItem, TypeHierarchyDirection } from "@theia/typehierarchy/lib/browser/typehierarchy-provider";
import { RepoGraphClient } from "./repo-graph-client";
import { AISymbol } from "./types";
import { aisymbolToTypeItem, uriToRepoPath } from "./type-utils";

const SUPPORTED_LANGUAGES = ["typescript", "javascript", "python", "go", "rust"];

function createProvider(lang: string, client: RepoGraphClient): TypeHierarchyProvider {
  return {
    languageId: lang,
    dispose: () => {},
    async get(params: TypeHierarchyParams): Promise<TypeHierarchyItem | undefined> {
      const line = params.position.line;
      const uri = params.textDocument.uri;
      const sym = await client.getSymbolAtPosition(uri, line);
      if (!sym) return undefined;
      return aisymbolToTypeItem(sym);
    },
    async resolve(params: ResolveTypeHierarchyItemParams): Promise<TypeHierarchyItem | undefined> {
      return {
        ...params.item,
        parents: [],
        children: [],
      };
    },
  };
}

@injectable()
export class MiziTypeHierarchyRegistrar {
  @inject(TypeHierarchyRegistry)
  private readonly registry: TypeHierarchyRegistry;

  @inject(RepoGraphClient)
  private readonly client: RepoGraphClient;

  @postConstruct()
  protected init(): void {
    for (const lang of SUPPORTED_LANGUAGES) {
      try {
        this.registry.register(createProvider(lang, this.client));
      } catch {
        // Provider for this lang may already be registered (e.g. by LSP)
      }
    }
  }
}
