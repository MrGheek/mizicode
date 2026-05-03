export const CATEGORY_ICONS: Record<string, string> = {
  colors: "🎨",
  typography: "Aa",
  charts: "📊",
  "ui-patterns": "⬜",
  fonts: "T",
  icons: "✦",
  palette: "🎨",
  style: "◈",
};

export function categoryIcon(cat: string): string {
  const key = Object.keys(CATEGORY_ICONS).find((k) =>
    cat.toLowerCase().includes(k),
  );
  return key ? CATEGORY_ICONS[key] : "◆";
}

export const SKILL_CLASS_COLORS: Record<string, string> = {
  design: "text-purple-400 border-purple-500/30",
  ui: "text-indigo-400 border-indigo-500/30",
  frontend: "text-sky-400 border-sky-500/30",
  backend: "text-emerald-400 border-emerald-500/30",
  devops: "text-amber-400 border-amber-500/30",
};

export function skillClassColor(skillClass: string): string {
  return SKILL_CLASS_COLORS[skillClass] ?? "text-muted-foreground border-border/50";
}
