#!/bin/sh
# Push bot/catalog-snapshot and open or update one pull request.
# Never force-pushes and never merges that pull request.
# A clean tree does not open a pull request.
set -eu

branch="bot/catalog-snapshot"
base="${BASE_BRANCH:?}"
repo="${GITHUB_REPOSITORY:?}"
summary="${SUMMARY_FILE:?}"
commit_file="${COMMIT_FILE:?}"

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

paths="website/data/catalog-snapshot.json website/data/models-snapshot.json website/models website/sitemap.xml website/llms.txt website/llms-models.txt website/llms-full.txt website/_redirects website/index.html website/x402-llm-api/index.html website/.well-known/agent-card.json website/agent-spending-limits/index.html website/limit-ai-agent-spending/index.html website/x402-budget-for-agents/index.html"

# shellcheck disable=SC2086
git add -A -- $paths

if [ -n "$(git diff --name-only)" ] || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo "Refresh changed files outside the catalog page set:" >&2
  git diff --name-only >&2
  git ls-files --others --exclude-standard >&2
  exit 1
fi

if git diff --cached --quiet; then
  echo "No snapshot changes."
  number="$(gh pr list --repo "$repo" --head "$branch" --base "$base" --state open --limit 1 --json number --jq '.[0].number // empty')"
  if [ -n "$number" ]; then
    gh pr close "$number" --repo "$repo" --comment "The public catalog matches \`$base\` again, so this refresh has nothing to merge."
  fi
  exit 0
fi

tree="$(git write-tree)"
refresh_commit="$(git commit-tree "$tree" -p HEAD -F "$commit_file")"
git reset --hard HEAD
git fetch origin "$base"
if ! git fetch origin "$branch"; then
  echo "No existing ${branch} branch; creating it from ${base}."
fi

if git rev-parse --verify --quiet "refs/remotes/origin/${branch}"; then
  git checkout -B "$branch" "origin/${branch}"
  if ! git merge --no-edit "origin/${base}"; then
    git checkout --theirs -- .
    git add -A
    if [ -n "$(git diff --name-only --diff-filter=U)" ]; then
      echo "Merge with ${base} still has conflicts." >&2
      exit 1
    fi
    if git diff --cached --quiet; then
      git -c commit.template=/dev/null commit --allow-empty -m "Merge ${base} into ${branch}"
    else
      git -c commit.template=/dev/null commit -m "Merge ${base} into ${branch}"
    fi
  fi
else
  git checkout -B "$branch" "origin/${base}"
fi

# Replace generated paths, including deletions, with the refreshed tree.
# shellcheck disable=SC2086
git rm -r --quiet --ignore-unmatch -- $paths
present=""
for path in $paths; do
  if git cat-file -e "${refresh_commit}:${path}" 2>/dev/null; then
    present="$present $path"
  fi
done
if [ -n "$present" ]; then
  # shellcheck disable=SC2086
  git checkout "$refresh_commit" -- $present
fi

if git diff --cached --quiet; then
  echo "Refresh branch already has this snapshot."
else
  git -c commit.template=/dev/null commit -F "$commit_file"
fi

git push origin "HEAD:${branch}"

number="$(gh pr list --repo "$repo" --head "$branch" --base "$base" --state open --limit 1 --json number --jq '.[0].number // empty')"
if [ -n "$number" ]; then
  gh pr edit "$number" --repo "$repo" --title "Refresh website catalog snapshot" --body-file "$summary"
else
  gh pr create --repo "$repo" --base "$base" --head "$branch" --title "Refresh website catalog snapshot" --body-file "$summary"
fi
