package com.enterpriseapp.android.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HealthSyncDtoTest {
    private val json = ApiClient.ApiJson

    @Test fun `registration carries appVersionCode`() {
        val body = json.encodeToString(
            RegisterDeviceRequest.serializer(),
            RegisterDeviceRequest(installationId = "i", name = "Pixel", appVersion = "0.2.0", appVersionCode = 3),
        )
        assertTrue(body, body.contains("\"appVersion\":\"0.2.0\""))
        assertTrue(body, body.contains("\"appVersionCode\":3"))
    }

    @Test fun `registration omits an unknown appVersionCode`() {
        val body = json.encodeToString(RegisterDeviceRequest.serializer(), RegisterDeviceRequest(installationId = "i", name = "Pixel"))
        assertFalse(body, body.contains("appVersionCode"))
    }

    @Test fun `device view reads the update fields`() {
        val device = json.decodeFromString(
            HealthSyncDevice.serializer(),
            """{"id":"d","appVersionCode":2,"latestVersionCode":4,"updateAvailable":true,"extra":1}""",
        )
        assertEquals(2, device.appVersionCode)
        assertEquals(4, device.latestVersionCode)
        assertEquals(true, device.updateAvailable)
    }
}
