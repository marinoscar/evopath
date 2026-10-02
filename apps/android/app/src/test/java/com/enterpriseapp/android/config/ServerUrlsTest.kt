package com.enterpriseapp.android.config

import com.enterpriseapp.android.testing.FakeSharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerUrlsTest {
    private fun valid(input: String): String {
        val result = ServerUrls.normalize(input)
        assertTrue("expected $input to be valid, got $result", result is ServerUrlResult.Valid)
        return (result as ServerUrlResult.Valid).url
    }

    private fun assertInvalid(input: String?) {
        val result = ServerUrls.normalize(input)
        assertTrue("expected $input to be invalid, got $result", result is ServerUrlResult.Invalid)
    }

    @Test fun `adds https when no scheme is given`() = assertEquals("https://app.example.com", valid("app.example.com"))

    @Test fun `trims whitespace and trailing slashes`() =
        assertEquals("https://app.example.com", valid("  https://app.example.com///  "))

    @Test fun `lowercases scheme and host`() = assertEquals("https://app.example.com", valid("HTTPS://App.Example.COM/"))

    @Test fun `keeps a non-default port and drops 443`() {
        assertEquals("https://app.example.com:8443", valid("https://app.example.com:8443"))
        assertEquals("https://app.example.com", valid("https://app.example.com:443"))
    }

    @Test fun `accepts ip addresses and localhost`() {
        assertEquals("https://192.168.1.20:3535", valid("192.168.1.20:3535"))
        assertEquals("https://localhost", valid("localhost"))
        assertEquals("https://[::1]:8443", valid("https://[::1]:8443"))
    }

    @Test fun `rejects empty and blank input`() {
        assertInvalid(null)
        assertInvalid("")
        assertInvalid("   ")
    }

    @Test fun `rejects non https schemes`() {
        assertInvalid("http://app.example.com")
        assertInvalid("ftp://app.example.com")
        assertInvalid("javascript://alert(1)")
    }

    @Test fun `rejects paths queries fragments and credentials`() {
        assertInvalid("https://app.example.com/app")
        assertInvalid("https://app.example.com/?source=twa")
        assertInvalid("https://app.example.com/#x")
        assertInvalid("https://user:pass@app.example.com")
    }

    @Test fun `rejects malformed hosts`() {
        assertInvalid("https://")
        assertInvalid("myserver")
        assertInvalid("app server.example.com")
        assertInvalid("https://exa mple.com")
    }

    @Test fun `builds the twa launch url with the app version`() =
        assertEquals(
            "https://app.example.com/?source=twa&appVersion=0.2.1&appVersionCode=7",
            ServerUrls.twaLaunchUrl("https://app.example.com/", "0.2.1", 7),
        )

    @Test fun `encodes an unusual version name in the twa launch url`() =
        assertEquals(
            "https://app.example.com:8443/?source=twa&appVersion=1.0+beta%261&appVersionCode=12",
            ServerUrls.twaLaunchUrl("https://app.example.com:8443", "1.0 beta&1", 12),
        )

    // --- twaLaunchUrlFor: incoming https links ------------------------------------------------

    private val start = "https://app.example.com/?source=twa&appVersion=1.1.1&appVersionCode=7"

    private fun launch(incoming: String?, server: String = "https://app.example.com") =
        ServerUrls.twaLaunchUrlFor(server, incoming, "1.1.1", 7)

    @Test fun `no incoming link opens the start url`() {
        assertEquals(start, launch(null))
        assertEquals(start, launch(""))
    }

    @Test fun `a link on the server host opens that page with the launch parameters`() {
        assertEquals(
            "https://app.example.com/workouts/42?tab=sets&source=twa&appVersion=1.1.1&appVersionCode=7#top",
            launch("https://app.example.com/workouts/42?tab=sets#top"),
        )
        assertEquals(start, launch("https://app.example.com/"))
        assertEquals(start, launch("https://APP.example.com"))
    }

    @Test fun `launch parameters in the link are replaced, not duplicated`() =
        assertEquals(
            "https://app.example.com/coach?source=twa&appVersion=1.1.1&appVersionCode=7",
            launch("https://app.example.com/coach?source=web&appVersionCode=1"),
        )

    @Test fun `links to another origin open the start url`() {
        assertEquals(start, launch("https://evil.example.net/workouts"))
        assertEquals(start, launch("https://sub.app.example.com/"))
        assertEquals(start, launch("http://app.example.com/workouts"))
        assertEquals(start, launch("https://app.example.com:8443/workouts"))
        assertEquals(start, launch("example-android://health-sync"))
        assertEquals(start, launch("not a url"))
    }

    @Test fun `a non-default port must match the configured server`() =
        assertEquals(
            "https://app.example.com:8443/a?source=twa&appVersion=1.1.1&appVersionCode=7",
            launch("https://app.example.com:8443/a", server = "https://app.example.com:8443"),
        )
}

class ServerConfigTest {
    @Test fun `unconfigured when nothing is stored and the build default is empty`() {
        val config = ServerConfig(FakeSharedPreferences(), buildDefault = "")
        assertNull(config.serverUrl)
        assertFalse(config.isConfigured)
    }

    @Test fun `falls back to a normalized build default`() {
        val config = ServerConfig(FakeSharedPreferences(), buildDefault = "app.example.com/")
        assertEquals("https://app.example.com", config.serverUrl)
        assertFalse(config.isUserDefined)
    }

    @Test fun `an invalid build default counts as unconfigured`() {
        assertNull(ServerConfig(FakeSharedPreferences(), buildDefault = "http://insecure.example.com").serverUrl)
    }

    @Test fun `a saved url wins over the build default and clear restores it`() {
        val config = ServerConfig(FakeSharedPreferences(), buildDefault = "https://default.example.com")
        val result = config.setServerUrl("Mine.Example.com")
        assertEquals(ServerUrlResult.Valid("https://mine.example.com"), result)
        assertEquals("https://mine.example.com", config.serverUrl)
        assertTrue(config.isUserDefined)

        config.clear()
        assertEquals("https://default.example.com", config.serverUrl)
    }

    @Test fun `an invalid url is not saved`() {
        val config = ServerConfig(FakeSharedPreferences(), buildDefault = "")
        assertTrue(config.setServerUrl("http://nope.example.com") is ServerUrlResult.Invalid)
        assertNull(config.serverUrl)
    }
}
