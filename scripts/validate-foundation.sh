#!/bin/sh
set -eu

required_files='
.github/copilot-instructions.md
README.md
docs/ARCHITECTURE.md
docs/FEATURES.md
docs/ACCOUNTING-EXAMPLES.md
docs/STYLE-GUIDE.md
.gitignore
'

legacy_pattern='Home Ledger|SQLite|ledger\.db|Plex|password-based|single-file'

for file in $required_files; do
  [ -f "$file" ] || {
    echo "missing required file: $file" >&2
    exit 1
  }
done

if grep -n -E "$legacy_pattern" README.md .github/copilot-instructions.md
then
  echo 'found prohibited legacy reference(s) in foundation documents' >&2
  exit 1
fi

if find docs -type f -exec grep -n -E "$legacy_pattern" {} +
then
  echo 'found prohibited legacy reference(s) in foundation documents' >&2
  exit 1
fi

echo 'foundation validation passed'
