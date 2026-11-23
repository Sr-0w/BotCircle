package app.dot.opendots

import app.dot.opendots.ui.cleanSessionTitle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** #69: what the rename dialog sends. */
class RenameSessionTest {
    @Test fun collapsesWhitespace() = assertEquals("Implémentation des chats éphémères", cleanSessionTitle("  Implémentation   des chats\néphémères "))
    @Test fun refusesBlank() { assertNull(cleanSessionTitle("")); assertNull(cleanSessionTitle(" \n\t ")) }
    @Test fun refusesTooLong() { assertNull(cleanSessionTitle("x".repeat(201))); assertEquals(200, cleanSessionTitle("x".repeat(200))?.length) }
}
