import { TaskConfiguration, RevealKind, TaskScope } from "@theia/task/lib/common/task-protocol";

export const LANGUAGE_TASKS: TaskConfiguration[] = [
  { type: "mizi", _label: "MIZI: Run Tests (Python)", label: "MIZI: Run Tests (Python)", _scope: TaskScope.Global, task: "test", config: { command: "python -m pytest" }, presentation: { reveal: RevealKind.Always } },
  { type: "mizi", _label: "MIZI: Run Tests (Go)", label: "MIZI: Run Tests (Go)", _scope: TaskScope.Global, task: "test", config: { command: "go test ./..." }, presentation: { reveal: RevealKind.Always } },
  { type: "mizi", _label: "MIZI: Run Tests (Rust)", label: "MIZI: Run Tests (Rust)", _scope: TaskScope.Global, task: "test", config: { command: "cargo test" }, presentation: { reveal: RevealKind.Always } },
  { type: "mizi", _label: "MIZI: TypeCheck (TypeScript)", label: "MIZI: TypeCheck (TypeScript)", _scope: TaskScope.Global, task: "check", config: { command: "tsc --noEmit" }, presentation: { reveal: RevealKind.Always } },
  { type: "mizi", _label: "MIZI: Run Tests (JS/Node)", label: "MIZI: Run Tests (JS/Node)", _scope: TaskScope.Global, task: "test", config: { command: "npm test" }, presentation: { reveal: RevealKind.Always } },
  { type: "mizi", _label: "MIZI: Run Tests (Ruby)", label: "MIZI: Run Tests (Ruby)", _scope: TaskScope.Global, task: "test", config: { command: "bundle exec rspec" }, presentation: { reveal: RevealKind.Always } },
  { type: "mizi", _label: "MIZI: Run Tests (Java)", label: "MIZI: Run Tests (Java)", _scope: TaskScope.Global, task: "test", config: { command: "mvn test" }, presentation: { reveal: RevealKind.Always } },
  { type: "mizi", _label: "MIZI: Run Tests (Swift)", label: "MIZI: Run Tests (Swift)", _scope: TaskScope.Global, task: "test", config: { command: "swift test" }, presentation: { reveal: RevealKind.Always } },
  { type: "mizi", _label: "MIZI: Build (C++)", label: "MIZI: Build (C++)", _scope: TaskScope.Global, task: "build", config: { command: "cmake --build build && ctest" }, presentation: { reveal: RevealKind.Always } },
  { type: "mizi", _label: "MIZI: Run Tests (Kotlin)", label: "MIZI: Run Tests (Kotlin)", _scope: TaskScope.Global, task: "test", config: { command: "gradle test" }, presentation: { reveal: RevealKind.Always } },
  { type: "mizi", _label: "MIZI: Format (Rust)", label: "MIZI: Format (Rust)", _scope: TaskScope.Global, task: "fmt", config: { command: "cargo fmt" }, presentation: { reveal: RevealKind.Silent } },
  { type: "mizi", _label: "MIZI: Lint (TypeScript)", label: "MIZI: Lint (TypeScript)", _scope: TaskScope.Global, task: "lint", config: { command: "npx eslint ." }, presentation: { reveal: RevealKind.Always } },
];

export function getTasksForLanguages(languages: string[]): TaskConfiguration[] {
  const langTaskMap: Record<string, string[]> = {
    python: ["MIZI: Run Tests (Python)"],
    go: ["MIZI: Run Tests (Go)"],
    rust: ["MIZI: Run Tests (Rust)", "MIZI: Format (Rust)"],
    typescript: ["MIZI: TypeCheck (TypeScript)", "MIZI: Lint (TypeScript)"],
    javascript: ["MIZI: Run Tests (JS/Node)"],
    ruby: ["MIZI: Run Tests (Ruby)"],
    java: ["MIZI: Run Tests (Java)"],
    swift: ["MIZI: Run Tests (Swift)"],
    cpp: ["MIZI: Build (C++)"],
    kotlin: ["MIZI: Run Tests (Kotlin)"],
  };

  const matchedLabels = new Set<string>();
  for (const lang of languages) {
    const tasks = langTaskMap[lang.toLowerCase()];
    if (tasks) for (const t of tasks) matchedLabels.add(t);
  }

  return LANGUAGE_TASKS.filter((t) => matchedLabels.has(t._label));
}
