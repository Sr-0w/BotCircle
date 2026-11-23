"""Static checks only: NOT a Kotlin/Compose compilation or an Android test run.

Optional grammar check:
  PYTHONPATH=/tmp/opencode/botcircle-kotlin-check python3 tools/check_temporary_chat.py
Requires tree-sitter==0.25.2 and tree-sitter-kotlin==1.1.0 for that extra check.
"""
from pathlib import Path
import re
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parents[1]
src = root / "app/src/main/kotlin/app/dot/opendots"
test = root / "app/src/test/kotlin/app/dot/opendots/TemporaryChatTest.kt"
files = [
    src / "data/TemporaryChat.kt", src / "data/OpenDotsClient.kt",
    src / "chat/TemporaryChatSession.kt", src / "ui/EphemeralChatScreen.kt", src / "ui/ChatScreen.kt",
    src / "ui/ChatsPages.kt", src / "AppState.kt", src / "MainActivity.kt", test,
    root / "app/src/test/kotlin/app/dot/opendots/ScreensTest.kt",
]
resources = []
for locale in ("values", "values-fr"):
    resources.append({node.attrib["name"] for node in ET.parse(root / f"app/src/main/res/{locale}/strings.xml").getroot()})
assert resources[0] == resources[1], "Resource sets differ between languages"
used = set()
for path in files:
    used.update(re.findall(r"\bR\.string\.(\w+)", path.read_text()))
assert not used - resources[0], f"Missing resources: {used - resources[0]}"
assert not [r for r in resources[0] if r.startswith("temporary_")], "old temporary_* strings must be gone"
assert len([r for r in resources[0] if r.startswith("ephemeral_")]) == 13
print("PASS static: English/French resource parity and referenced strings")

for path in [src / "chat/TemporaryChatSession.kt", src / "ui/EphemeralChatScreen.kt"]:
    code = re.sub(r"/\*.*?\*/|//[^\n]*", "", path.read_text(), flags=re.S)
    assert not re.search(r"\b(rememberSaveable|SavedStateHandle|SessionStore|SharedPreferences|println)\b|\bLog\.", code), path
    assert not re.search(r"\.(uploadImage|uploadArtifact|createChat|chat|messages|react|regenerate)\(", code), path
print("PASS static: ephemeral state/screen has no durable store, logging, upload or normal-chat calls")
assert not (src / "ui/TemporaryChatPage.kt").exists(), "the separate temporary page must stay removed"
assert "TemporaryChat" not in (src / "ui/ChatsPages.kt").read_text() and "temporary-chat-action" not in (src / "ui/ChatsPages.kt").read_text()
main = (src / "MainActivity.kt").read_text()
assert "Page.TemporaryChat" not in main and "confirmTemporaryExit" not in main and "app.exitEphemeral()" in main
print("PASS static: no separate temporary entry, page or exit dialog; leaving the ephemeral chat discards it")

client = (src / "data/OpenDotsClient.kt").read_text()
section = client.split("// --- Temporary chat:", 1)[1].split("// --- Server & account", 1)[0]
assert '"/temporary-chats"' in section and '"/temporary-chats/$id"' in section
assert "readTemporaryEvents" in section and "awaitClose { call.cancel() }" in section
assert 'setOf("openrouter", "ollama")' in section
assert 'put("providerOrder"' not in section
state = (src / "AppState.kt").read_text()
for start, end in [("fun changeServer()", "fun signIn"), ("fun signOut()", "fun saveKey"), ("private fun unauthorized()", "// --- Realtime")]:
    assert "dropEphemeral()" in state.split(start, 1)[1].split(end, 1)[0]
assert "temporaryChat.discard()" in state.split("private fun dropEphemeral()", 1)[1].split("fun startEphemeral", 1)[0]
start = state.split("fun startEphemeral", 1)[1].split("fun stopEphemeral", 1)[0]
assert "client.deleteChat(chat.id" in start and "chats.filterNot { it.id == chat.id }" in start, "the empty normal chat must be deleted and unlisted"
assert "client.createChat()" in state.split("fun stopEphemeral", 1)[1].split("fun exitEphemeral", 1)[0]
assert "HEARTBEAT_MS = 30_000L" in (src / "chat/TemporaryChatSession.kt").read_text()
assert "temporaryChat.dispose()" in state and "temporaryChat.foreground(visible)" in state
print("PASS static: temporary endpoint family, named SSE cancellation, restricted providers and auth/lifecycle cleanup")

try:
    import tree_sitter
    import tree_sitter_kotlin
except ImportError:
    print("SKIP Kotlin grammar parsing: install the optional tree-sitter packages")
else:
    parser = tree_sitter.Parser(tree_sitter.Language(tree_sitter_kotlin.language()))
    failures = []
    for path in files:
        tree = parser.parse(path.read_bytes())
        todo = [tree.root_node]
        while todo:
            node = todo.pop()
            if node.is_error or node.is_missing:
                failures.append(f"{path.relative_to(root)}:{node.start_point.row + 1}: {node.type}")
            todo.extend(node.children)
    assert not failures, "\n".join(failures)
    print(f"PASS Kotlin grammar parsing: {len(files)} source/test files (syntax only, NOT type checking)")
print(f"INFO: {len(re.findall(r'@Test', test.read_text()))} Android JUnit tests defined; this script does NOT execute them")
