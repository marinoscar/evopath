package com.enterpriseapp.android.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AppInfoTest {
    @Test fun `formats bytes as uppercase colon separated hex`() {
        assertEquals("00:0A:7F:80:FF", AppInfo.formatFingerprint(byteArrayOf(0x00, 0x0a, 0x7f, 0x80.toByte(), 0xff.toByte())))
    }

    @Test fun `empty digest formats as empty string`() = assertEquals("", AppInfo.formatFingerprint(ByteArray(0)))

    @Test fun `sha256 fingerprint matches the assetlinks format`() {
        // SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
        val fp = AppInfo.sha256Fingerprint("abc".toByteArray())
        assertEquals(
            "BA:78:16:BF:8F:01:CF:EA:41:41:40:DE:5D:AE:22:23:B0:03:61:A3:96:17:7A:9C:B4:10:FF:61:F2:00:15:AD",
            fp,
        )
        // Same regex the API validates signingSha256 with.
        assertTrue(Regex("^([0-9A-F]{2}:){31}[0-9A-F]{2}$").matches(fp))
    }
}
