#!/bin/bash

# Get current Apple Note content
NOTE_CONTENT=$(osascript -e 'tell app "Notes" to get body of first note whose name is "ai-political-compass"' 2>/dev/null)
if [ -z "$NOTE_CONTENT" ]; then
  echo "[Claude] ⚠️  Could not read ai-political-compass note"
  exit 1
fi

echo "[Claude Note Sync] 📝 Current priorities:"
echo "$NOTE_CONTENT" | grep -E '^[\*\-\✓✅]' | head -15 || echo "  (empty or no bullet points found)"
echo ""

# Check for items marked with ✅ or [x] (completed markers)
COMPLETED=$(echo "$NOTE_CONTENT" | grep -E '(✅|✓|\[x\]|\[X\])' | wc -l)
if [ "$COMPLETED" -gt 0 ]; then
  echo "[Claude Note Sync] ✨ Found $COMPLETED completed items:"
  echo "$NOTE_CONTENT" | grep -E '(✅|✓|\[x\]|\[X\])' | sed 's/^/  🔹 /'
  echo ""
  echo "[Claude Note Sync] 🔄 To auto-remove completed items, reply with:"
  echo "  'sync note and remove all completed items'"
fi

echo "[Claude Note Sync] 💡 Quick commands:"
echo "  • 'add priority: [description]' → I'll add to your note"
echo "  • 'remove priority: [description]' → I'll remove from your note"
echo "  • 'sync note' → show full note contents"
