Add the release notes Markdown file to this directory.
Edit `releases.json`, keeping upcoming entries first and published entries newest first.
Run `node scripts/generate-changelog.mjs` to update the page.
Flip status to `published` and add the date and release URL only after the GitHub release is public.
