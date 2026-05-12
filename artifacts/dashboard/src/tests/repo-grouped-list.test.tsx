/**
 * Integration tests for the RepoGroupedList component.
 *
 * These tests render the real Command/CommandGroup/CommandItem tree
 * (the same cmdk primitives used in LaunchSessionDialog) and make
 * DOM assertions about org headings and repo placement.
 *
 * Covers:
 * - All org headings are rendered in alphabetical order
 * - Each repo appears under the correct org heading
 * - Repos from different orgs do not bleed into each other's groups
 * - Private repos display a "Private" badge; public repos display "Public"
 * - The selected repo shows an opaque check mark; others show opacity-0
 * - Empty repo list shows the "No repos found." empty state
 * - Single-org list shows exactly one heading with all its repos
 * - Clicking a repo item fires onSelect with the correct repo object
 * - Filtering: repos not matching the Command search are hidden
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Command, CommandInput } from "@/components/ui/command";
import { RepoGroupedList } from "@/components/repo-grouped-list";
import type { GitHubRepo } from "@/hooks/use-github-repos";

function makeRepo(
  fullName: string,
  owner: string,
  opts: { private?: boolean; cloneUrl?: string } = {}
): GitHubRepo {
  const name = fullName.split("/")[1]!;
  return {
    fullName,
    name,
    owner,
    private: opts.private ?? false,
    htmlUrl: `https://github.com/${fullName}`,
    cloneUrl: opts.cloneUrl ?? `https://github.com/${fullName}.git`,
  };
}

const ALICE_A = makeRepo("alice/alpha", "alice");
const ALICE_B = makeRepo("alice/beta", "alice", { private: true });
const ACME_X = makeRepo("acme-corp/x-service", "acme-corp");
const ACME_Y = makeRepo("acme-corp/y-service", "acme-corp");
const ACME_Z = makeRepo("acme-corp/z-lib", "acme-corp", { private: true });
const SOLO = makeRepo("solo-user/only-repo", "solo-user");

const ALL_REPOS: GitHubRepo[] = [ALICE_A, ALICE_B, ACME_X, ACME_Y, ACME_Z, SOLO];

function renderList(
  repos: GitHubRepo[],
  selectedCloneUrl = "",
  onSelect = vi.fn()
) {
  return render(
    <Command>
      <CommandInput placeholder="Search repos…" />
      <RepoGroupedList
        repos={repos}
        selectedCloneUrl={selectedCloneUrl}
        onSelect={onSelect}
      />
    </Command>
  );
}

// ─── Heading rendering ────────────────────────────────────────────────────────

describe("org headings", () => {
  it("renders one heading per distinct owner", () => {
    renderList(ALL_REPOS);
    const groups = screen.getAllByRole("group");
    expect(groups).toHaveLength(3);
  });

  it("renders owner names as group headings", () => {
    renderList(ALL_REPOS);
    expect(screen.getByRole("group", { name: /alice/i })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /acme-corp/i })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /solo-user/i })).toBeInTheDocument();
  });

  it("sorts headings alphabetically (acme-corp < alice < solo-user)", () => {
    renderList(ALL_REPOS);
    const groups = screen.getAllByRole("group");
    const headingTexts = groups.map((g) => g.getAttribute("aria-label") ?? "");
    const sorted = [...headingTexts].sort();
    expect(headingTexts).toEqual(sorted);
  });

  it("renders a single heading when all repos share one owner", () => {
    const aliceOnly = [ALICE_A, ALICE_B];
    renderList(aliceOnly);
    const groups = screen.getAllByRole("group");
    expect(groups).toHaveLength(1);
    expect(screen.getByRole("group", { name: /alice/i })).toBeInTheDocument();
  });
});

// ─── Repo placement under correct org ────────────────────────────────────────

describe("repo placement under correct org", () => {
  it("places alice repos only under the alice group", () => {
    renderList(ALL_REPOS);
    const aliceGroup = screen.getByRole("group", { name: /alice/i });
    const aliceItems = within(aliceGroup).getAllByRole("option");
    const aliceNames = aliceItems.map((el) => el.textContent ?? "");
    expect(aliceNames.some((t) => t.includes("alpha"))).toBe(true);
    expect(aliceNames.some((t) => t.includes("beta"))).toBe(true);
    expect(aliceNames.some((t) => t.includes("x-service"))).toBe(false);
  });

  it("places acme repos only under the acme-corp group", () => {
    renderList(ALL_REPOS);
    const acmeGroup = screen.getByRole("group", { name: /acme-corp/i });
    const acmeItems = within(acmeGroup).getAllByRole("option");
    const acmeNames = acmeItems.map((el) => el.textContent ?? "");
    expect(acmeNames.some((t) => t.includes("x-service"))).toBe(true);
    expect(acmeNames.some((t) => t.includes("y-service"))).toBe(true);
    expect(acmeNames.some((t) => t.includes("z-lib"))).toBe(true);
    expect(acmeNames.some((t) => t.includes("alpha"))).toBe(false);
  });

  it("solo-user group contains exactly one repo", () => {
    renderList(ALL_REPOS);
    const soloGroup = screen.getByRole("group", { name: /solo-user/i });
    const soloItems = within(soloGroup).getAllByRole("option");
    expect(soloItems).toHaveLength(1);
    expect(soloItems[0]!.textContent).toMatch(/only-repo/);
  });

  it("does not bleed repos from one org into another", () => {
    renderList(ALL_REPOS);
    const acmeGroup = screen.getByRole("group", { name: /acme-corp/i });
    const aliceGroup = screen.getByRole("group", { name: /alice/i });

    const acmeNames = within(acmeGroup)
      .getAllByRole("option")
      .map((el) => el.textContent ?? "");
    const aliceNames = within(aliceGroup)
      .getAllByRole("option")
      .map((el) => el.textContent ?? "");

    for (const n of aliceNames) {
      expect(acmeNames.join("\n")).not.toContain(n.trim());
    }
  });
});

// ─── Private / Public badge ───────────────────────────────────────────────────

describe("private / public badge", () => {
  it("shows 'Private' label for private repos", () => {
    renderList([ALICE_B]);
    expect(screen.getByText("Private")).toBeInTheDocument();
  });

  it("shows 'Public' label for public repos", () => {
    renderList([ALICE_A]);
    expect(screen.getByText("Public")).toBeInTheDocument();
  });

  it("mixes private and public badges correctly within a group", () => {
    renderList([ALICE_A, ALICE_B]);
    expect(screen.getByText("Private")).toBeInTheDocument();
    expect(screen.getByText("Public")).toBeInTheDocument();
  });
});

// ─── Selection state (check mark opacity) ────────────────────────────────────

describe("selection indicator", () => {
  it("shows an opaque check for the selected repo's item", () => {
    renderList(ALL_REPOS, ALICE_A.cloneUrl);
    const aliceGroup = screen.getByRole("group", { name: /alice/i });
    const alphaItem = within(aliceGroup)
      .getAllByRole("option")
      .find((el) => el.textContent?.includes("alpha"))!;

    const check = alphaItem.querySelector("svg");
    expect(check).not.toBeNull();
    expect(check!.getAttribute("class")).toMatch(/opacity-100/);
  });

  it("shows opacity-0 checks for non-selected repos", () => {
    renderList(ALL_REPOS, ALICE_A.cloneUrl);
    const acmeGroup = screen.getByRole("group", { name: /acme-corp/i });
    const acmeItems = within(acmeGroup).getAllByRole("option");
    for (const item of acmeItems) {
      const check = item.querySelector("svg");
      expect(check).not.toBeNull();
      expect(check!.getAttribute("class")).toMatch(/opacity-0/);
    }
  });

  it("shows no opaque checks when nothing is selected", () => {
    renderList(ALL_REPOS, "");
    const allItems = screen.getAllByRole("option");
    for (const item of allItems) {
      const check = item.querySelector("svg");
      const cls = check?.getAttribute("class") ?? "";
      if (cls.includes("opacity-")) {
        expect(cls).toMatch(/opacity-0/);
      }
    }
  });
});

// ─── Empty state ──────────────────────────────────────────────────────────────

describe("empty state", () => {
  it("shows 'No repos found.' when the repo list is empty", () => {
    renderList([]);
    expect(screen.getByText("No repos found.")).toBeInTheDocument();
  });

  it("does not render any groups when the repo list is empty", () => {
    renderList([]);
    expect(screen.queryAllByRole("group")).toHaveLength(0);
  });
});

// ─── onSelect callback ────────────────────────────────────────────────────────

describe("onSelect callback", () => {
  it("fires onSelect with the correct repo when an item is clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderList([ALICE_A, ACME_X], "", onSelect);

    const alphaItem = screen.getAllByRole("option").find(
      (el) => el.textContent?.includes("alpha")
    )!;
    await user.click(alphaItem);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(ALICE_A);
  });

  it("fires onSelect with the acme repo when that item is clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderList([ALICE_A, ACME_X], "", onSelect);

    const xItem = screen.getAllByRole("option").find(
      (el) => el.textContent?.includes("x-service")
    )!;
    await user.click(xItem);

    expect(onSelect).toHaveBeenCalledWith(ACME_X);
  });
});

// ─── Filtering via CommandInput ───────────────────────────────────────────────

describe("filtering via CommandInput search", () => {
  it("hides repos that don't match the search query", async () => {
    const user = userEvent.setup();
    renderList(ALL_REPOS);

    const input = screen.getByPlaceholderText("Search repos…");
    await user.type(input, "alpha");

    const visibleOptions = screen.getAllByRole("option");
    expect(visibleOptions.some((el) => el.textContent?.includes("alpha"))).toBe(true);
    expect(visibleOptions.some((el) => el.textContent?.includes("x-service"))).toBe(false);
  });

  it("shows 'No repos found.' when search matches nothing", async () => {
    const user = userEvent.setup();
    renderList(ALL_REPOS);

    const input = screen.getByPlaceholderText("Search repos…");
    await user.type(input, "zzz-no-match-xyz");

    expect(screen.getByText("No repos found.")).toBeInTheDocument();
  });

  it("shows all repos when search is cleared", async () => {
    const user = userEvent.setup();
    renderList([ALICE_A, ACME_X, SOLO]);

    const input = screen.getByPlaceholderText("Search repos…");
    await user.type(input, "alpha");
    await user.clear(input);

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
  });
});
