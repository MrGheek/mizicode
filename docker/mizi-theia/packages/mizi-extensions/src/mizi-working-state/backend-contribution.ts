import { injectable, postConstruct, inject } from "@theia/core/shared/inversify";
import { EditorManager } from "@theia/editor/lib/browser/editor-manager";
import { EditorWidget } from "@theia/editor/lib/browser/editor-widget";
import {
  AIVariableService,
  AIVariableContribution,
  AIVariableResolver,
  AIVariableResolutionRequest,
  AIVariableContext,
  ResolvedAIVariable,
  AIContextVariable,
} from "@theia/ai-core/lib/common/variable-service";

@injectable()
export class MiziWorkingStateContribution implements AIVariableContribution, AIVariableResolver {
  @inject(AIVariableService)
  protected readonly variableService: AIVariableService;

  @inject(EditorManager)
  protected readonly editorManager: EditorManager;

  readonly variable: AIContextVariable = {
    id: "mizi_working_state",
    name: "mizi_working_state",
    description: "Current editor state: open files, cursor position, recent edits",
    isContextVariable: true,
    label: "Working State",
  };

  @postConstruct()
  protected init(): void {
    this.variableService.registerVariable(this.variable);
    this.variableService.registerResolver(this.variable, this);
  }

  registerVariables(service: AIVariableService): void {
    service.registerVariable(this.variable);
    service.registerResolver(this.variable, this);
  }

  canResolve(request: AIVariableResolutionRequest, _context: AIVariableContext): number {
    return request.variable.id === this.variable.id ? 100 : 0;
  }

  async resolve(request: AIVariableResolutionRequest, _context: AIVariableContext): Promise<ResolvedAIVariable | undefined> {
    const parts: string[] = ["## Working State\n"];

    const editorWidget = this.editorManager.currentEditor;
    if (editorWidget) {
      const uri = editorWidget.editor.uri;
      const cursor = editorWidget.editor.cursor;
      parts.push(`- **Active file**: \`${uri.path.toString()}\``);
      parts.push(`- **Cursor**: line ${cursor.line + 1}, character ${cursor.character + 1}`);
      const selection = editorWidget.editor.selection;
      if (selection) {
        const isCollapsed = selection.start.line === selection.end.line && selection.start.character === selection.end.character;
        if (!isCollapsed) {
          parts.push(`- **Selection**: lines ${selection.start.line + 1}–${selection.end.line + 1}`);
        }
      }
      parts.push("");
    }

    const allEditors: EditorWidget[] = (this.editorManager as any).all || [];
    if (allEditors.length > 1) {
      parts.push(`**Open files** (${allEditors.length} total):`);
      for (const e of allEditors) {
        const marker = e.editor.uri.toString() === editorWidget?.editor.uri.toString() ? " ← active" : "";
        parts.push(`- \`${e.editor.uri.path.toString()}\`${marker}`);
      }
      parts.push("");
    }

    const text = parts.join("\n");
    return { variable: this.variable, value: text, contextValue: text } as ResolvedAIVariable;
  }
}
