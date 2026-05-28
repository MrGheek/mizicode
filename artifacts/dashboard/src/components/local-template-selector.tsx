/**
 * LocalTemplateSelector
 *
 * Workspace template selection for Mizi-Local new session flow.
 * Displays available agent configuration templates (debug, review, build, etc.)
 * from the workspace-templates service. Selected template slug is passed back
 * via onTemplateSelected callback and fed into the session start payload.
 */

import { useState } from "react";

interface WorkspaceTemplate {
  slug: string;
  name: string;
  description: string;
  mode: string;
  icon: string;
  tags: string[];
}

const TEMPLATES: WorkspaceTemplate[] = [
  {
    slug: "build",
    name: "Build Mode",
    description: "Implementation focused. Writes clean, working code efficiently.",
    mode: "build",
    icon: "🔨",
    tags: ["implementation", "development"],
  },
  {
    slug: "debug",
    name: "Debug Mode",
    description: "Focused on finding and fixing bugs. Methodical, root-cause oriented.",
    mode: "debug",
    icon: "🐛",
    tags: ["debugging", "testing"],
  },
  {
    slug: "review",
    name: "Review Mode",
    description: "Code review assistant. Identifies issues, suggests improvements, flags risks.",
    mode: "review",
    icon: "🔍",
    tags: ["review", "quality", "security"],
  },
  {
    slug: "explore",
    name: "Explore Mode",
    description: "Research and discovery. Understands codebases, maps architecture.",
    mode: "explore",
    icon: "🗺️",
    tags: ["research", "architecture"],
  },
  {
    slug: "refactor",
    name: "Refactor Mode",
    description: "Improves code structure without changing behaviour. Safe, incremental.",
    mode: "refactor",
    icon: "♻️",
    tags: ["refactoring", "clean-code"],
  },
  {
    slug: "test",
    name: "Test Mode",
    description: "Test writing specialist. Comprehensive coverage, maintainable tests.",
    mode: "test",
    icon: "✅",
    tags: ["testing", "coverage"],
  },
  {
    slug: "document",
    name: "Document Mode",
    description: "Documentation writer. Clear, accurate, developer-friendly docs.",
    mode: "document",
    icon: "📝",
    tags: ["documentation"],
  },
];

interface LocalTemplateSelectorProps {
  value?: string | null;
  onTemplateSelected: (slug: string | null) => void;
}

export function LocalTemplateSelector({
  value,
  onTemplateSelected,
}: LocalTemplateSelectorProps) {
  return (
    <div className="space-y-2">
      <div className="text-xs text-zinc-500 mb-3">
        Choose how the agent approaches this session. You can change this later.
      </div>
      <div className="grid grid-cols-1 gap-2">
        {TEMPLATES.map((t) => {
          const isSelected = value === t.slug;
          return (
            <button
              key={t.slug}
              type="button"
              onClick={() => onTemplateSelected(isSelected ? null : t.slug)}
              className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors ${
                isSelected
                  ? "bg-blue-900/20 border-blue-600 text-zinc-100"
                  : "bg-zinc-900 border-zinc-800 text-zinc-300 hover:border-zinc-600"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-lg leading-none">{t.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{t.name}</span>
                    <div className="flex gap-1 ml-auto">
                      {t.tags.slice(0, 2).map((tag) => (
                        <span
                          key={tag}
                          className="text-xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                  <p className="text-xs text-zinc-500 mt-0.5 truncate">{t.description}</p>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
