import { injectable, inject, postConstruct } from "@theia/core/shared/inversify";
import { LanguageModelRegistry } from "@theia/ai-core";
import { ConnectionHandler } from "@theia/core/lib/common/messaging/handler";
import { MiziNimModelManager } from "./mizi-nim-model-manager";
import { createLanguageModel } from "./nim-language-model-factory";

@injectable()
export class MiziNimConnectionService {
  @inject(LanguageModelRegistry)
  protected readonly languageModelRegistry: LanguageModelRegistry;

  @inject(MiziNimModelManager)
  protected readonly modelManager: MiziNimModelManager;

  private registeredIds = new Set<string>();
  private disposable: { dispose: () => void } | undefined;

  @postConstruct()
  protected init(): void {
    this.syncModels().catch(() => {});
    this.disposable = this.modelManager.onDidChange(() => this.syncModels().catch(() => {}));
  }

  private async syncModels(): Promise<void> {
    const models = await this.modelManager.getModels();
    const languageModels = models.map(createLanguageModel);
    const newIds = new Set(languageModels.map((m) => m.id));
    const removedIds: string[] = [];
    for (const existingId of this.registeredIds) {
      if (!newIds.has(existingId)) removedIds.push(existingId);
    }
    if (removedIds.length > 0) {
      this.languageModelRegistry.removeLanguageModels(removedIds);
    }
    this.languageModelRegistry.addLanguageModels(languageModels);
    this.registeredIds = newIds;
  }
}

export function createMiziNimConnectionHandler(): ConnectionHandler {
  return {
    path: "mizi-nim-connection-init",
    onConnection: () => {
      // This handler gets resolved into the connection container;
      // the binding that uses this triggers MiziNimConnectionService creation.
    },
  };
}
