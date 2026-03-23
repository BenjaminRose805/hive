#!/usr/bin/env bash
set -euo pipefail

TARGET="/home/benjamin/.claude/plugins/cache/claude-plugins-official/discord/0.0.1/server.ts"

if grep -q "isAllowedBot" "$TARGET" 2>/dev/null; then
  echo "Patch already applied."
  exit 0
fi

if ! grep -q 'if (msg.author.bot) return' "$TARGET"; then
  echo "ERROR: Cannot find target line in server.ts. Plugin may have been updated."
  exit 1
fi

# Apply the patch using bun/node inline script
bun -e "
const fs = require('fs');
const target = '$TARGET';
let code = fs.readFileSync(target, 'utf8');
const oldCode = 'if (msg.author.bot) return';
const newCode = \`if (msg.author.bot) {
    const access = loadAccess()
    const isAllowedBot =
      access.allowFrom.includes(msg.author.id) ||
      Object.values(access.groups).some(g => (g.allowFrom ?? []).includes(msg.author.id))
    if (!isAllowedBot) return
  }\`;
code = code.replace(oldCode, newCode);
fs.writeFileSync(target, code);
console.log('Patch applied successfully.');
"
